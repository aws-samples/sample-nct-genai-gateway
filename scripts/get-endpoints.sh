#!/usr/bin/env bash
# NLB DNS 조회 → cdk.json 'vllmEndpoints' context 업데이트
# 사용법: ./scripts/get-endpoints.sh [--write-context]
#
#  --write-context  조회된 DNS를 cdk.json context에 자동 기록
#
# bash 3.2(macOS 기본) 호환: associative array를 쓰지 않고 'alias:service' 라인 목록으로 처리.

set -euo pipefail

WRITE_CONTEXT=false
for arg in "$@"; do
  [[ "$arg" == "--write-context" ]] && WRITE_CONTEXT=true
done

NAMESPACE="vllm"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_JSON="$SCRIPT_DIR/../cdk.json"

# alias:nlb-service-name (config/models.ts의 6개 alias와 일치)
MODEL_SERVICES="
coding:qwen35-27b-nlb
video:qwen35-27b-video-nlb
ocr:internvl3-14b-nlb
longcontext:llama4-scout-nlb
math:gemma4-31b-nlb
audio:phi4-multimodal-nlb
"

echo "▶ NLB DNS 조회 (namespace: $NAMESPACE)"
echo ""

# alias\tendpoint 라인을 누적 (bash 3 호환)
ENDPOINT_LINES=""
COUNT=0

for pair in $MODEL_SERVICES; do
  alias="${pair%%:*}"
  svc="${pair##*:}"
  hostname=$(kubectl get svc -n "$NAMESPACE" "$svc" \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")

  if [[ -z "$hostname" ]]; then
    echo "  ⚠  $alias ($svc): NLB 아직 프로비저닝 중 (Service 없거나 hostname 미할당)"
  else
    endpoint="http://${hostname}:8000"
    ENDPOINT_LINES="${ENDPOINT_LINES}${alias}	${endpoint}
"
    COUNT=$(( COUNT + 1 ))
    echo "  ✓ $alias → $endpoint"
  fi
done

echo ""

if [[ "$COUNT" -eq 0 ]]; then
  echo "조회된 NLB DNS가 없습니다. vLLM NLB Service가 Ready 상태인지 확인하세요:"
  echo "  kubectl get svc -n $NAMESPACE"
  exit 1
fi

if [[ "$WRITE_CONTEXT" == "true" ]]; then
  echo "▶ cdk.json 'vllmEndpoints' context 업데이트"

  # Python으로 cdk.json context 업데이트 (alias\tendpoint 라인을 stdin으로 전달)
  printf '%s' "$ENDPOINT_LINES" | python3 - "$CDK_JSON" <<'PYTHON'
import json, sys

cdk_json = sys.argv[1]
endpoints = {}
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line:
        continue
    alias, endpoint = line.split("\t", 1)
    endpoints[alias] = endpoint

with open(cdk_json) as f:
    cdk = json.load(f)

cdk.setdefault("context", {})["vllmEndpoints"] = endpoints

with open(cdk_json, "w") as f:
    json.dump(cdk, f, indent=2, ensure_ascii=False)
    f.write("\n")

print("  ✓ cdk.json 업데이트 완료")
print("  vllmEndpoints:", json.dumps(endpoints, indent=4))
PYTHON

  echo ""
  echo "다음 단계: SmartRouter 재배포 + Higress provider/route 재적용"
  echo "  cdk deploy NctSmartRouterStack -c higressEndpoint=<higress-nlb-dns> --require-approval never"
  echo "  ./scripts/apply-higress.sh"
else
  echo "cdk.json에 아직 기록하지 않았습니다."
  echo "--write-context 옵션을 추가하면 자동으로 업데이트됩니다:"
  echo "  ./scripts/get-endpoints.sh --write-context"
fi

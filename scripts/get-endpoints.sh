#!/usr/bin/env bash
# NLB DNS 조회 → cdk.json 'vllmEndpoints' context 업데이트
# 사용법: ./scripts/get-endpoints.sh [--write-context]
#
#  --write-context  조회된 DNS를 cdk.json context에 자동 기록

set -euo pipefail

WRITE_CONTEXT=false
for arg in "$@"; do
  [[ "$arg" == "--write-context" ]] && WRITE_CONTEXT=true
done

NAMESPACE="vllm"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CDK_JSON="$SCRIPT_DIR/../cdk.json"

declare -A MODEL_SERVICES=(
  ["coding"]="qwen35-27b-nlb"
  ["ocr"]="internvl3-14b-nlb"
  ["longcontext"]="llama4-scout-nlb"
  ["math"]="gemma4-31b-nlb"
  ["audio"]="phi4-multimodal-nlb"
)

echo "▶ NLB DNS 조회 (namespace: $NAMESPACE)"
echo ""

declare -A ENDPOINTS=()

for alias in "${!MODEL_SERVICES[@]}"; do
  svc="${MODEL_SERVICES[$alias]}"
  hostname=$(kubectl get svc -n "$NAMESPACE" "$svc" \
    -o jsonpath='{.status.loadBalancer.ingress[0].hostname}' 2>/dev/null || echo "")

  if [[ -z "$hostname" ]]; then
    echo "  ⚠  $alias ($svc): NLB 아직 프로비저닝 중 (Service 없거나 hostname 미할당)"
  else
    endpoint="http://${hostname}:8000"
    ENDPOINTS["$alias"]="$endpoint"
    echo "  ✓ $alias → $endpoint"
  fi
done

echo ""

if [[ "${#ENDPOINTS[@]}" -eq 0 ]]; then
  echo "조회된 NLB DNS가 없습니다. vLLM NLB Service가 Ready 상태인지 확인하세요:"
  echo "  kubectl get svc -n $NAMESPACE"
  exit 1
fi

if [[ "$WRITE_CONTEXT" == "true" ]]; then
  echo "▶ cdk.json 'vllmEndpoints' context 업데이트"

  # JSON 오브젝트 빌드
  JSON_PARTS=()
  for alias in "${!ENDPOINTS[@]}"; do
    JSON_PARTS+=("\"$alias\": \"${ENDPOINTS[$alias]}\"")
  done
  ENDPOINTS_JSON="{$(IFS=,; echo "${JSON_PARTS[*]}")}"

  # Python으로 cdk.json context 업데이트 (jq 없이도 동작)
  python3 - <<PYTHON
import json, sys

with open('$CDK_JSON', 'r') as f:
    cdk = json.load(f)

endpoints = json.loads('$ENDPOINTS_JSON')
cdk.setdefault('context', {})['vllmEndpoints'] = endpoints

with open('$CDK_JSON', 'w') as f:
    json.dump(cdk, f, indent=2, ensure_ascii=False)
    f.write('\n')

print("  ✓ cdk.json 업데이트 완료")
print("  vllmEndpoints:", json.dumps(endpoints, indent=4))
PYTHON

  echo ""
  echo "다음 단계: NctLiteLLMStack 재배포"
  echo "  cdk deploy NctLiteLLMStack --require-approval never"
else
  echo "cdk.json에 아직 기록하지 않았습니다."
  echo "--write-context 옵션을 추가하면 자동으로 업데이트됩니다:"
  echo "  ./scripts/get-endpoints.sh --write-context"
fi

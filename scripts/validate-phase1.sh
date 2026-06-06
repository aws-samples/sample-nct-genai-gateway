#!/usr/bin/env bash
# Phase 1 검증: Qwen3.5-27B E2E 테스트
# 사용법:
#   ./scripts/validate-phase1.sh --cold-start          # EFS 마운트 + 콜드스타트 시간 측정
#   ./scripts/validate-phase1.sh --e2e                 # LiteLLM alias 경유 E2E 테스트
#   ./scripts/validate-phase1.sh --scale-cycle         # scale-to-zero → scale-up 사이클 검증
#   ./scripts/validate-phase1.sh --all                 # 전체 검증

set -euo pipefail

MODE=""
for arg in "$@"; do
  case "$arg" in
    --cold-start)   MODE="cold-start" ;;
    --e2e)          MODE="e2e" ;;
    --scale-cycle)  MODE="scale-cycle" ;;
    --all)          MODE="all" ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "사용법: $0 --cold-start | --e2e | --scale-cycle | --all"
  exit 1
fi

NAMESPACE="vllm"
SERVING_NAME="qwen35-27b"
LITELLM_ENDPOINT=${LITELLM_ENDPOINT:-"http://localhost:4000"}
LITELLM_API_KEY=${LITELLM_API_KEY:-""}

# ─── 헬퍼 ─────────────────────────────────────────────────────────────────────
wait_for_pod_ready() {
  local label="$1"
  local timeout="${2:-600}"
  echo "  Waiting for pod ($label) to be Ready (timeout: ${timeout}s)..."
  kubectl wait pod -n "$NAMESPACE" -l "app=$label" \
    --for=condition=Ready --timeout="${timeout}s"
}

measure_seconds() {
  local start=$SECONDS
  "$@"
  echo $(( SECONDS - start ))
}

# ─── cold-start ───────────────────────────────────────────────────────────────
run_cold_start() {
  echo ""
  echo "=== Cold-Start 검증 ==="

  # PVC 상태 확인
  echo "▶ EFS PVC 상태"
  kubectl get pvc -n "$NAMESPACE" "model-cache-$SERVING_NAME" 2>/dev/null || {
    echo "  ⚠  PVC 없음 — NctVllm-Coding 아직 배포 안 됨"
    return 1
  }
  pvc_status=$(kubectl get pvc -n "$NAMESPACE" "model-cache-$SERVING_NAME" \
    -o jsonpath='{.status.phase}')
  echo "  PVC status: $pvc_status"
  [[ "$pvc_status" == "Bound" ]] && echo "  ✓ EFS PVC Bound" || echo "  ⚠  PVC not Bound yet"

  # Pod 상태
  echo ""
  echo "▶ vLLM Pod 상태 (minReplicas=0: 초기에 pod 없을 수 있음)"
  kubectl get pods -n "$NAMESPACE" -l "app=$SERVING_NAME" 2>/dev/null || true

  # Pod 0개이면 replica를 1로 수동 스케일 업
  POD_COUNT=$(kubectl get pods -n "$NAMESPACE" -l "app=$SERVING_NAME" \
    --field-selector=status.phase=Running --no-headers 2>/dev/null | wc -l || echo 0)
  if [[ "$POD_COUNT" -eq 0 ]]; then
    echo ""
    echo "  Pod이 없음 (scale-to-zero). 콜드 스타트 측정을 위해 수동 scale-up..."
    START_TS=$SECONDS
    kubectl scale deployment -n "$NAMESPACE" "$SERVING_NAME" --replicas=1
  else
    START_TS=$SECONDS
    echo "  Pod 이미 Running: $POD_COUNT 개"
  fi

  # Ready 대기
  wait_for_pod_ready "$SERVING_NAME" 900
  COLD_START_SEC=$(( SECONDS - START_TS ))
  echo ""
  echo "  ✓ 콜드 스타트 시간: ${COLD_START_SEC}초"

  if [[ "$COLD_START_SEC" -lt 120 ]]; then
    echo "  ✓ EFS 캐시 HIT (< 2분): 모델이 이미 EFS에 캐시됨"
  elif [[ "$COLD_START_SEC" -lt 600 ]]; then
    echo "  ⚠  중간 속도 (2~10분): HuggingFace 다운로드 중이거나 일부 캐시됨"
  else
    echo "  ⚠  느린 콜드스타트 (> 10분): HuggingFace 최초 다운로드 — 이후 EFS 캐시됨"
  fi

  # /health 확인
  echo ""
  echo "▶ vLLM /health 직접 확인"
  POD=$(kubectl get pods -n "$NAMESPACE" -l "app=$SERVING_NAME" \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null)
  if [[ -n "$POD" ]]; then
    kubectl exec -n "$NAMESPACE" "$POD" -- \
      curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health && echo ""
    echo "  ✓ vLLM /health OK"
  fi
}

# ─── e2e ──────────────────────────────────────────────────────────────────────
run_e2e() {
  echo ""
  echo "=== E2E 테스트 (LiteLLM coding alias) ==="

  [[ -z "$LITELLM_API_KEY" ]] && {
    echo "  ⚠  LITELLM_API_KEY 환경변수가 없습니다."
    echo "     aws secretsmanager get-secret-value --secret-id /nct/litellm/master-key \\"
    echo "       --query SecretString --output text | python3 -c \"import sys,json; print(json.load(sys.stdin)['key'])\""
    exit 1
  }

  # NLB로 port-forward 하거나 LITELLM_ENDPOINT를 ALB DNS로 설정해야 함
  echo "▶ LiteLLM 연결 확인 ($LITELLM_ENDPOINT)"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$LITELLM_ENDPOINT/health" || echo "000")
  if [[ "$HTTP_CODE" != "200" ]]; then
    echo ""
    echo "  LiteLLM에 연결할 수 없습니다 (HTTP $HTTP_CODE)."
    echo "  VPN/Direct Connect 연결 또는 kubectl port-forward를 확인하세요:"
    echo ""
    echo "  # kubectl port-forward로 로컬 테스트:"
    echo "  ALB_SVC=\$(kubectl get svc -n default -o name | head -1)"
    echo "  -- 또는 --"
    echo "  LITELLM_ENDPOINT=http://<alb-dns>:4000 ./scripts/validate-phase1.sh --e2e"
    exit 1
  fi
  echo "  ✓ LiteLLM 연결 OK"

  # coding alias 테스트
  echo ""
  echo "▶ 'coding' alias 테스트 (Qwen3.5-27B)"
  RESPONSE=$(curl -s -X POST "$LITELLM_ENDPOINT/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $LITELLM_API_KEY" \
    -d '{
      "model": "coding",
      "messages": [{"role": "user", "content": "Write a Python function that returns the nth Fibonacci number. Just the code, no explanation."}],
      "max_tokens": 200,
      "temperature": 0
    }')

  MODEL_USED=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('model','unknown'))" 2>/dev/null || echo "parse error")
  CONTENT=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])" 2>/dev/null || echo "parse error")

  echo "  모델: $MODEL_USED"
  echo "  응답:"
  echo "$CONTENT" | head -20 | sed 's/^/    /'

  if echo "$CONTENT" | grep -qi "def\|fibonacci\|return"; then
    echo "  ✓ coding alias E2E 테스트 통과"
  else
    echo "  ⚠  응답이 예상과 다릅니다. 전체 응답:"
    echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
    exit 1
  fi

  # claude alias 테스트 (Bedrock fallback)
  echo ""
  echo "▶ 'claude-3-5-sonnet-20241022' alias 테스트 (Bedrock fallback)"
  RESPONSE2=$(curl -s -X POST "$LITELLM_ENDPOINT/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $LITELLM_API_KEY" \
    -d '{
      "model": "claude-3-5-sonnet-20241022",
      "messages": [{"role": "user", "content": "Reply with only the word: PONG"}],
      "max_tokens": 10,
      "temperature": 0
    }')

  CONTENT2=$(echo "$RESPONSE2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])" 2>/dev/null || echo "parse error")
  echo "  응답: $CONTENT2"

  if echo "$CONTENT2" | grep -qi "PONG"; then
    echo "  ✓ Bedrock fallback E2E 테스트 통과"
  else
    echo "  ⚠  Bedrock 응답 예상과 다름"
    echo "$RESPONSE2"
  fi

  echo ""
  echo "✓ Phase 1 E2E 테스트 완료"
}

# ─── scale-cycle ──────────────────────────────────────────────────────────────
run_scale_cycle() {
  echo ""
  echo "=== Scale-to-Zero → Scale-Up 사이클 검증 ==="

  # 현재 replica 수
  CURRENT=$(kubectl get deployment -n "$NAMESPACE" "$SERVING_NAME" \
    -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)
  echo "  현재 replicas: $CURRENT"

  # scale-to-zero
  echo ""
  echo "▶ Scale-to-zero"
  kubectl scale deployment -n "$NAMESPACE" "$SERVING_NAME" --replicas=0
  kubectl wait pod -n "$NAMESPACE" -l "app=$SERVING_NAME" \
    --for=delete --timeout=120s 2>/dev/null || true
  echo "  ✓ 모든 pod 종료됨"
  kubectl get pods -n "$NAMESPACE" -l "app=$SERVING_NAME" --no-headers 2>/dev/null | wc -l

  # scale-up
  echo ""
  echo "▶ Scale-up (→ 1 replica)"
  START_TS=$SECONDS
  kubectl scale deployment -n "$NAMESPACE" "$SERVING_NAME" --replicas=1
  wait_for_pod_ready "$SERVING_NAME" 900
  ELAPSED=$(( SECONDS - START_TS ))

  echo ""
  echo "  ✓ Scale-up 완료: ${ELAPSED}초"
  kubectl get pods -n "$NAMESPACE" -l "app=$SERVING_NAME"

  if [[ "$ELAPSED" -lt 300 ]]; then
    echo "  ✓ EFS 캐시 효과 확인 (< 5분): 모델 로딩 빠름"
  else
    echo "  ℹ  Scale-up ${ELAPSED}초 — HuggingFace에서 다운로드 중일 수 있음"
    echo "     EFS에 캐시된 후 재측정 권장"
  fi

  # HPA 상태 확인
  echo ""
  echo "▶ HPA 상태"
  kubectl get hpa -n "$NAMESPACE" "$SERVING_NAME" 2>/dev/null || \
    echo "  HPA 없음 (minReplicas=0 HPA는 KEDA 필요 — 현재 수동 scale)"
}

# ─── main ──────────────────────────────────────────────────────────────────────
case "$MODE" in
  cold-start)   run_cold_start ;;
  e2e)          run_e2e ;;
  scale-cycle)  run_scale_cycle ;;
  all)
    run_cold_start
    run_e2e
    run_scale_cycle
    ;;
esac

echo ""
echo "=== Phase 1 검증 완료 ==="

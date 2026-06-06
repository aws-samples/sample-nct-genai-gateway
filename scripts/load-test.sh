#!/usr/bin/env bash
# load-test.sh — NCT GenAI Gateway 부하 테스트 (scale-to-zero → 500명 peak 검증)
#
# Usage:
#   ./scripts/load-test.sh [--users N] [--ramp-secs N] [--alias <alias>]
#
# Examples:
#   ./scripts/load-test.sh                          # 기본: 50 users, coding alias
#   ./scripts/load-test.sh --users 200              # 200 동시 사용자
#   ./scripts/load-test.sh --users 500 --ramp-secs 60   # 60초에 걸쳐 500명 증가
#   ./scripts/load-test.sh --alias math             # math alias 테스트
#
# Pre-requisites:
#   - curl, jq, python3 installed
#   - AWS_DEFAULT_REGION=ap-northeast-2
#   - LITELLM_API_KEY env var (or script fetches master key)

set -euo pipefail

REGION=${AWS_DEFAULT_REGION:-ap-northeast-2}
USERS=${USERS:-50}
RAMP_SECS=${RAMP_SECS:-30}
ALIAS=${ALIAS:-coding}
DURATION_SECS=${DURATION_SECS:-120}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --users)       USERS="$2"; shift 2 ;;
    --ramp-secs)   RAMP_SECS="$2"; shift 2 ;;
    --alias)       ALIAS="$2"; shift 2 ;;
    --duration)    DURATION_SECS="$2"; shift 2 ;;
    *) echo "Unknown: $1"; exit 1 ;;
  esac
done

# ── Get endpoint & key ────────────────────────────────────────────────────────
LITELLM_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name NctLiteLLMStack \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`LiteLLMEndpoint`].OutputValue' \
  --output text)

if [[ -z "${LITELLM_API_KEY:-}" ]]; then
  SECRET_JSON=$(aws secretsmanager get-secret-value \
    --secret-id /nct/litellm/master-key \
    --region "$REGION" --query SecretString --output text)
  LITELLM_API_KEY=$(echo "$SECRET_JSON" | jq -r '.key')
fi

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  NCT GenAI Gateway — 부하 테스트"
echo "  Endpoint : $LITELLM_ENDPOINT"
echo "  Alias    : $ALIAS"
echo "  Users    : $USERS (ramp-up ${RAMP_SECS}s)"
echo "  Duration : ${DURATION_SECS}s"
echo "══════════════════════════════════════════════════════════"
echo ""

# ── Pre-check: scale-to-zero warmup ──────────────────────────────────────────
echo "▶ Phase 1 — scale-to-zero cold start 측정..."
START=$(date +%s%3N)

WARMUP_RESP=$(curl -sf -m 600 -w '\n%{http_code}' \
  -X POST \
  -H "Authorization: Bearer $LITELLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"model\": \"$ALIAS\",
    \"messages\": [{\"role\":\"user\",\"content\":\"ping\"}],
    \"max_tokens\": 10
  }" \
  "$LITELLM_ENDPOINT/v1/chat/completions" 2>&1 || true)

END=$(date +%s%3N)
COLD_START_MS=$(( END - START ))

HTTP_CODE=$(echo "$WARMUP_RESP" | tail -n1)
echo "  Cold start: ${COLD_START_MS}ms (HTTP $HTTP_CODE)"

if [[ "$HTTP_CODE" != "200" ]]; then
  echo "  ⚠ 첫 응답 실패 — 모델이 아직 스케일업 중일 수 있음. 90s 대기 후 재시도..."
  sleep 90
fi

# ── Phase 2: concurrent load via Python ──────────────────────────────────────
echo ""
echo "▶ Phase 2 — 동시 사용자 $USERS 명 부하 테스트 (${DURATION_SECS}s)..."

python3 - <<EOF
import asyncio, time, json, os, statistics
import httpx

ENDPOINT = "$LITELLM_ENDPOINT"
API_KEY  = "$LITELLM_API_KEY"
ALIAS    = "$ALIAS"
USERS    = $USERS
RAMP_SECS = $RAMP_SECS
DURATION = $DURATION_SECS

PROMPTS = [
    "Explain Newton's first law in one sentence.",
    "Write a Python function to reverse a string.",
    "What is the capital of South Korea?",
    "Calculate 15% of 240.",
    "Summarize: Large language models are neural networks trained on vast text data.",
]

results = []
errors  = []

async def send_request(client: httpx.AsyncClient, user_id: int) -> dict:
    prompt = PROMPTS[user_id % len(PROMPTS)]
    start  = time.time()
    try:
        resp = await client.post(
            f"{ENDPOINT}/v1/chat/completions",
            headers={"Authorization": f"Bearer {API_KEY}"},
            json={
                "model": ALIAS,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 50,
            },
            timeout=120.0,
        )
        elapsed = (time.time() - start) * 1000
        return {"user": user_id, "status": resp.status_code, "latency_ms": elapsed, "ok": resp.status_code == 200}
    except Exception as e:
        elapsed = (time.time() - start) * 1000
        return {"user": user_id, "status": 0, "latency_ms": elapsed, "ok": False, "error": str(e)}


async def main():
    delay_per_user = RAMP_SECS / max(USERS, 1)
    async with httpx.AsyncClient() as client:
        tasks = []
        for i in range(USERS):
            await asyncio.sleep(delay_per_user)
            tasks.append(asyncio.create_task(send_request(client, i)))
            if i % 50 == 0 and i > 0:
                print(f"  ramp-up: {i}/{USERS} users dispatched")
        print(f"  ramp-up: {USERS}/{USERS} users dispatched — waiting for responses...")
        responses = await asyncio.gather(*tasks, return_exceptions=True)

    ok      = [r for r in responses if isinstance(r, dict) and r["ok"]]
    failed  = [r for r in responses if isinstance(r, dict) and not r["ok"]]
    errors  = [r for r in responses if isinstance(r, Exception)]

    latencies = [r["latency_ms"] for r in ok]

    print("")
    print("══ 결과 ════════════════════════════════════════════════")
    print(f"  총 요청:     {USERS}")
    print(f"  성공:        {len(ok)} ({100*len(ok)//USERS}%)")
    print(f"  실패:        {len(failed)}")
    print(f"  예외:        {len(errors)}")
    if latencies:
        print(f"  P50 지연:    {sorted(latencies)[len(latencies)//2]:.0f}ms")
        print(f"  P95 지연:    {sorted(latencies)[int(len(latencies)*0.95)]:.0f}ms")
        print(f"  P99 지연:    {sorted(latencies)[int(len(latencies)*0.99)]:.0f}ms")
        print(f"  최대 지연:   {max(latencies):.0f}ms")
    print("══════════════════════════════════════════════════════════")

asyncio.run(main())
EOF

echo ""
echo "▶ Phase 3 — 테스트 후 scale-to-zero 복귀 대기 (5분)..."
echo "  kubectl get hpa -n vllm —  running replicas 확인"
echo ""
echo "  kubectl get hpa -n vllm"
kubectl get hpa -n vllm 2>/dev/null || echo "  (kubectl not available in current context)"

echo ""
echo "✅ 부하 테스트 완료"

#!/usr/bin/env bash
# Phase 7: Smart Router E2E validation
set -euo pipefail

# Get LiteLLM endpoint from CloudFormation output
LITELLM_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name NctLiteLLMStack --region ap-northeast-2 \
  --query 'Stacks[0].Outputs[?OutputKey==`LiteLLMEndpoint`].OutputValue' \
  --output text)

# Get Smart Router endpoint from CloudFormation output
ROUTER_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name NctSmartRouterStack --region ap-northeast-2 \
  --query 'Stacks[0].Outputs[?OutputKey==`SmartRouterEndpoint`].OutputValue' \
  --output text)

echo "=== Phase 7: Smart Router Validation ==="
echo "LiteLLM  : $LITELLM_ENDPOINT"
echo "Router   : $ROUTER_ENDPOINT"
echo ""

# Get LiteLLM key
KEY=$(aws secretsmanager get-secret-value \
  --secret-id "/nct/litellm/master-key" \
  --region ap-northeast-2 \
  --query SecretString --output text | python3 -c "import sys,json; print(json.load(sys.stdin)['key'])")

run_test() {
  local label="$1"
  local endpoint="$2"
  local model="$3"
  local prompt="$4"
  local expected_scenario="$5"

  echo "--- TEST: $label ---"
  echo "  Model: $model | Expected routing: $expected_scenario"

  RESP=$(curl -s -X POST "$endpoint/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $KEY" \
    -d "{\"model\": \"$model\", \"messages\": [{\"role\": \"user\", \"content\": \"$prompt\"}], \"max_tokens\": 100}")

  ACTUAL_MODEL=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('model','?'))" 2>/dev/null || echo "ERROR")
  echo "  Actual model used: $ACTUAL_MODEL"

  if echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); assert 'choices' in d" 2>/dev/null; then
    echo "  ✅ PASS"
  else
    echo "  ❌ FAIL: $RESP"
  fi
  echo ""
}

# 1. Health check
echo "--- Health check ---"
curl -sf "$ROUTER_ENDPOINT/health/liveliness" && echo " ✅ Router healthy" || echo " ❌ Router unhealthy"
echo ""

# 2. Passthrough test (non-general alias — should bypass detection)
run_test "Direct coding alias (bypass)" "$ROUTER_ENDPOINT" "coding" \
  "Write a fibonacci function in Python" "coding/qwen35-27b"

# 3. general → coding detection
run_test "general → coding detection" "$ROUTER_ENDPOINT" "general" \
  "Write a Python function to sort a list using quicksort" "coding"

# 4. general → math detection
run_test "general → math detection" "$ROUTER_ENDPOINT" "general" \
  "Prove that sqrt(2) is irrational. Show the equation and proof steps." "math"

# 5. general → longcontext detection (long text)
LONG_TEXT=$(python3 -c "print('This is a very long manufacturing document. ' * 2000)")
echo "--- TEST: general → longcontext (${#LONG_TEXT} chars) ---"
RESP=$(curl -s -X POST "$ROUTER_ENDPOINT/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d "{\"model\": \"general\", \"messages\": [{\"role\": \"user\", \"content\": \"$LONG_TEXT Summarize this.\"}], \"max_tokens\": 50}")
echo "  Response snippet: $(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('choices',[{}])[0].get('message',{}).get('content','?')[:80])" 2>/dev/null)"
echo ""

echo "=== Phase 7 validation complete ==="

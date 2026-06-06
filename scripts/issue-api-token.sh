#!/usr/bin/env bash
# issue-api-token.sh — LiteLLM 연구원 API 토큰 발급
#
# Usage:
#   ./scripts/issue-api-token.sh <researcher_alias> [--expires-in <days>]
#
# Examples:
#   ./scripts/issue-api-token.sh kim123               # 기본 90일
#   ./scripts/issue-api-token.sh park456 --expires-in 30
#   ./scripts/issue-api-token.sh team-robotics --expires-in 365
#
# Pre-requisites:
#   - AWS_DEFAULT_REGION=ap-northeast-2
#   - kubectl configured for nct-gateway cluster
#   - jq installed

set -euo pipefail

REGION=${AWS_DEFAULT_REGION:-ap-northeast-2}
MASTER_KEY_SECRET="/nct/litellm/master-key"

usage() {
  echo "Usage: $0 <researcher_alias> [--expires-in <days>]"
  echo "       $0 --list"
  exit 1
}

# ── Parse args ────────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then usage; fi

LIST_MODE=false
RESEARCHER=""
EXPIRES_DAYS=90

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list)    LIST_MODE=true; shift ;;
    --expires-in) EXPIRES_DAYS="$2"; shift 2 ;;
    -*)        usage ;;
    *)         RESEARCHER="$1"; shift ;;
  esac
done

# ── Get LiteLLM master key ────────────────────────────────────────────────────
echo "▶ Fetching LiteLLM master key from Secrets Manager..."
SECRET_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$MASTER_KEY_SECRET" \
  --region "$REGION" \
  --query SecretString --output text)
MASTER_KEY=$(echo "$SECRET_JSON" | jq -r '.key')

# ── Get LiteLLM endpoint (from CloudFormation output) ─────────────────────────
echo "▶ Fetching LiteLLM endpoint..."
LITELLM_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name NctLiteLLMStack \
  --region "$REGION" \
  --query 'Stacks[0].Outputs[?OutputKey==`LiteLLMEndpoint`].OutputValue' \
  --output text)
echo "  LiteLLM: $LITELLM_ENDPOINT"

# ── List mode ─────────────────────────────────────────────────────────────────
if $LIST_MODE; then
  echo ""
  echo "▶ Listing all API tokens..."
  curl -sf \
    -H "Authorization: Bearer $MASTER_KEY" \
    "$LITELLM_ENDPOINT/key/list" | jq '.["keys"] // .data // .'
  exit 0
fi

if [[ -z "$RESEARCHER" ]]; then usage; fi

# ── Issue token ───────────────────────────────────────────────────────────────
# expires_in is in seconds; 0 = never expires
EXPIRES_SECS=$(( EXPIRES_DAYS * 86400 ))
if [[ "$EXPIRES_DAYS" -eq 0 ]]; then
  EXPIRES_SECS=0
fi

echo ""
echo "▶ Issuing API token for: $RESEARCHER (expires in ${EXPIRES_DAYS} days)"

RESPONSE=$(curl -sf -X POST \
  -H "Authorization: Bearer $MASTER_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"key_alias\": \"researcher-${RESEARCHER}\",
    \"duration\": \"${EXPIRES_DAYS}d\",
    \"metadata\": {
      \"researcher\": \"${RESEARCHER}\",
      \"issued_by\": \"$(whoami)\",
      \"issued_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
    }
  }" \
  "$LITELLM_ENDPOINT/key/generate")

API_KEY=$(echo "$RESPONSE" | jq -r '.key')

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  연구원: $RESEARCHER"
echo "  만료:   ${EXPIRES_DAYS}일 후"
echo ""
echo "  API Key: $API_KEY"
echo ""
echo "  Claude Code 설정 방법:"
echo "  ─────────────────────"
echo "  # CA 인증서 설치 (최초 1회)"
echo "  aws secretsmanager get-secret-value \\"
echo "    --secret-id /nct/gateway/ca-cert \\"
echo "    --query SecretString --output text \\"
echo "    --region ap-northeast-2 > nct-gateway-ca.crt"
echo ""
echo "  # macOS"
echo "  sudo security add-trusted-cert -d -r trustRoot \\"
echo "    -k /Library/Keychains/System.keychain nct-gateway-ca.crt"
echo ""
echo "  # ~/.claude/settings.json 또는 환경 변수"
echo "  export ANTHROPIC_BASE_URL=https://gateway.nct-gateway.internal"
echo "  export ANTHROPIC_API_KEY=$API_KEY"
echo ""
echo "  # 또는 .env"
echo "  ANTHROPIC_BASE_URL=https://gateway.nct-gateway.internal"
echo "  ANTHROPIC_API_KEY=$API_KEY"
echo "══════════════════════════════════════════════════════════"

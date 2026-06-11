"""
Smart Router — NCT GenAI Gateway
Routes `general` alias requests to the best scenario alias based on
content analysis (MIME type > text rules > default=coding).

Architecture:
  Client → (general) → SmartRouter → Higress gateway (scenario alias: coding/math/video/...)
  Client → (coding/math/...) → SmartRouter passes the alias through to the gateway
"""
import asyncio
import json
import os
import re
import httpx
import logging
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("smart-router")

app = FastAPI(title="NCT Smart Router")

# Upstream gateway base URL — the Higress AI Gateway's internal NLB on 443.
# e.g. https://internal-nlb:443
GATEWAY_BASE = os.environ.get("GATEWAY_BASE_URL", "").rstrip("/")

# TLS verification for the upstream gateway endpoint. Defaults to enabled (secure).
# Set VERIFY_TLS=false ONLY for internal VPC traffic terminating on a self-signed
# certificate (e.g. an internal ALB without an ACM-issued public cert), where the
# network path is already constrained to the VPC CIDR by security groups.
VERIFY_TLS = os.environ.get("VERIFY_TLS", "true").lower() not in ("false", "0", "no")

# Down-convert modern Anthropic Messages payloads so legacy backends accept them.
# Claude Code 2.x (verified against claude-cli/2.1.167) sends fields that the
# in-region (Seoul) Bedrock fallback — Claude 3.5 Sonnet 2024-06-20 — rejects with
# "Malformed input request", which silently kills the vLLM→Bedrock fallback. The
# self-hosted vLLM models are OpenAI-compatible and don't use these fields either,
# so stripping unconditionally is lossless on both the warm (vLLM) and cold
# (Bedrock) paths. Set STRIP_LEGACY_FIELDS=false to disable (e.g. once the Bedrock
# fallback target is a Claude 4.x model that supports them natively).
STRIP_LEGACY_FIELDS = os.environ.get("STRIP_LEGACY_FIELDS", "true").lower() not in ("false", "0", "no")
# Top-level keys 2.x adds that Bedrock Claude 3.5 v1 rejects (invalid enum /
# extraneous key). `thinking:{type:adaptive}`, context management edits, output cfg.
_LEGACY_TOP_LEVEL_FIELDS = ("thinking", "context_management", "output_config")

# ── Bedrock-direct fallback (gateway bypass) ────────────────────────────────────
# The gateway (Higress) translates Anthropic /v1/messages → vLLM natively, but its
# ai-proxy 2.0.0 Bedrock path mis-signs SigV4 for /v1/messages (it double-translates
# Anthropic→OpenAI-Chat→Bedrock-Converse — see higress#3809). So when the warm vLLM
# alias is unavailable (cold start = NLB has zero healthy targets → connection error;
# or a 4xx/5xx from the gateway, e.g. context-window overflow), we bypass the gateway
# entirely and call Bedrock's NATIVE Anthropic Messages endpoint directly via boto3.
# Bedrock accepts the Anthropic Messages body verbatim (model stripped, anthropic_version
# added) and returns native Anthropic JSON / streaming events — verified against
# claude-3-5-sonnet-20240620 incl. tool_use + streaming. Credentials come from the ECS
# task role's standard chain (no static keys). Only the /v1/messages path falls back —
# /v1/chat/completions is left to the gateway (no native Bedrock Anthropic equivalent).
BEDROCK_FALLBACK_MODEL_ID = os.environ.get("BEDROCK_FALLBACK_MODEL_ID", "")
BEDROCK_REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION", "")
FALLBACK_ENABLED = bool(BEDROCK_FALLBACK_MODEL_ID)
# Gateway response codes that should trigger the Bedrock-direct fallback. 4xx covers
# context-window overflow (the case the previous gateway could not handle); 5xx covers a cold/sick
# vLLM upstream surfaced by the gateway as a server error (the overflow case the
# previous gateway could not handle). 2xx/3xx pass through.
_FALLBACK_STATUS_MIN = 400
_ANTHROPIC_VERSION = "bedrock-2023-05-31"

# ── Cold-vLLM pre-flight (skip the gateway when the target alias is scaled to zero) ──
# When a vLLM alias is scaled to zero, its internal NLB still exists but has zero
# healthy targets. Routing such a request THROUGH the gateway (Higress) makes Envoy
# hang ~40s on the dead upstream before surfacing a 503 — only THEN would the reactive
# fallback above kick in, so a cold request costs ~41s end-to-end. To make the cold
# path fast, the router probes the alias's vLLM NLB /health DIRECTLY (the same in-VPC
# path the gateway uses to reach vLLM) with a short timeout BEFORE calling the gateway:
#   cold (connection refused/timeout, or non-200) → bypass the gateway, go straight to
#                                                    the Bedrock-direct fallback (~2s)
#   warm (HTTP 200)                               → flow through the gateway normally
#                                                    (its 600s read timeout is preserved
#                                                     for long agentic generations)
#   no endpoint mapped for the alias              → skip the probe, use the gateway
# The reactive fallback (gateway connection error / >= 400) is kept as a safety net.
# Disabled automatically when VLLM_ENDPOINTS is empty (e.g. the public-repo default) or
# explicitly via PREFLIGHT_VLLM_HEALTH=false.
try:
    VLLM_ENDPOINTS = json.loads(os.environ.get("VLLM_ENDPOINTS", "") or "{}")
    if not isinstance(VLLM_ENDPOINTS, dict):
        VLLM_ENDPOINTS = {}
except (ValueError, TypeError):
    VLLM_ENDPOINTS = {}
PREFLIGHT_VLLM_HEALTH = (
    os.environ.get("PREFLIGHT_VLLM_HEALTH", "true").lower() not in ("false", "0", "no")
    and bool(VLLM_ENDPOINTS)
)
_PREFLIGHT_TIMEOUT = httpx.Timeout(float(os.environ.get("PREFLIGHT_TIMEOUT", "2.0")))

_bedrock_runtime = None


def _get_bedrock_client():
    """Lazily build a boto3 bedrock-runtime client (task-role credential chain)."""
    global _bedrock_runtime
    if _bedrock_runtime is None:
        import boto3  # imported lazily so the module loads even without the dep

        _bedrock_runtime = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION or None)
    return _bedrock_runtime


def _to_bedrock_body(body: dict) -> str:
    """Convert an (already sanitized) Anthropic Messages body to a Bedrock invoke body.

    Bedrock's native Anthropic endpoint takes the same body with `model` removed and
    `anthropic_version` set to the Bedrock value. `stream` is a transport concern, not a
    body field on Bedrock, so it is stripped here. Everything else (system, tools,
    tool_choice, messages, max_tokens) is accepted verbatim.
    """
    out = {k: v for k, v in body.items() if k not in ("model", "stream", "anthropic_version")}
    out["anthropic_version"] = _ANTHROPIC_VERSION
    out.setdefault("max_tokens", 4096)
    return json.dumps(out)


async def _bedrock_fallback(body: dict, is_stream: bool) -> Response:
    """Call Bedrock's native Anthropic endpoint directly and adapt to FastAPI.

    boto3 is synchronous; run the blocking call in a thread so the event loop is not
    starved. For streaming, each chunk's bytes are already a native Anthropic event
    (message_start / content_block_delta / ...) — re-emit them as Anthropic SSE frames
    (`event:` + `data:`) exactly as Claude Code expects.
    """
    invoke_body = _to_bedrock_body(body)
    client = _get_bedrock_client()
    logger.info(
        f"vLLM upstream unavailable → Bedrock-direct fallback "
        f"(model={BEDROCK_FALLBACK_MODEL_ID}, stream={is_stream})"
    )

    if not is_stream:
        resp = await asyncio.to_thread(
            client.invoke_model,
            modelId=BEDROCK_FALLBACK_MODEL_ID,
            body=invoke_body,
        )
        payload = resp["body"].read()  # native Anthropic Message JSON
        return Response(
            content=payload,
            status_code=200,
            media_type="application/json",
            headers={"x-nct-fallback": "bedrock-direct"},
        )

    # Streaming: boto3 EventStream → Anthropic SSE. We materialize the synchronous
    # EventStream into queued SSE frames on a worker thread, then drain them async.
    queue: "asyncio.Queue[bytes | None]" = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def _pump():
        try:
            resp = client.invoke_model_with_response_stream(
                modelId=BEDROCK_FALLBACK_MODEL_ID,
                body=invoke_body,
            )
            for ev in resp["body"]:
                chunk = ev.get("chunk")
                if not chunk:
                    continue
                raw = chunk["bytes"]  # native Anthropic event JSON
                evt = json.loads(raw).get("type", "message")
                frame = f"event: {evt}\n".encode() + b"data: " + raw + b"\n\n"
                loop.call_soon_threadsafe(queue.put_nowait, frame)
        except Exception as exc:  # surface as an Anthropic-style error SSE frame
            logger.exception("Bedrock-direct streaming fallback failed")
            err = json.dumps(
                {"type": "error", "error": {"type": "api_error", "message": str(exc)}}
            ).encode()
            loop.call_soon_threadsafe(
                queue.put_nowait, b"event: error\n" + b"data: " + err + b"\n\n"
            )
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, None)

    async def stream_gen():
        # Kick the blocking EventStream pump onto a worker thread WITHOUT awaiting it,
        # so frames flow out of the queue as they are produced (true streaming).
        loop.run_in_executor(None, _pump)
        while True:
            frame = await queue.get()
            if frame is None:
                break
            yield frame

    return StreamingResponse(
        stream_gen(),
        media_type="text/event-stream",
        headers={"x-nct-fallback": "bedrock-direct"},
    )

# ── Scenario detection ────────────────────────────────────────────────────────

# Keywords that strongly suggest math/reasoning tasks
_MATH_PATTERNS = re.compile(
    r"\b(방정식|적분|미분|행렬|증명|수열|확률|통계|편미분|최적화|"
    r"equation|integral|derivative|matrix|proof|sequence|probability|"
    r"statistics|optimization|theorem|calculate|compute|solve)\b",
    re.IGNORECASE,
)

# Keywords that suggest coding tasks
_CODE_PATTERNS = re.compile(
    r"\b(함수|코드|구현|알고리즘|디버그|클래스|모듈|API|SDK|리팩터|테스트|"
    r"function|implement|algorithm|debug|class|module|refactor|test|"
    r"code|script|program|bug|error|exception|deploy|build|compile)\b",
    re.IGNORECASE,
)

# Keywords that suggest OCR / document tasks
_OCR_PATTERNS = re.compile(
    r"\b(도면|설계도|청사진|문서|OCR|텍스트 추출|표 인식|"
    r"drawing|blueprint|document|diagram|extract text|table recognition)\b",
    re.IGNORECASE,
)

LONG_CONTEXT_CHARS = 60_000  # ~16K tokens — route to longcontext model


def _has_audio(content: list) -> bool:
    for block in content:
        if isinstance(block, dict):
            src = block.get("source", {})
            mt = src.get("media_type", "")
            if mt.startswith("audio/"):
                return True
    return False


def _has_video(content: list) -> bool:
    for block in content:
        if isinstance(block, dict):
            src = block.get("source", {})
            mt = src.get("media_type", "")
            if mt.startswith("video/"):
                return True
            # Anthropic video block type
            if block.get("type") == "video":
                return True
    return False


def _extract_text(messages: list) -> str:
    parts = []
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, str):
            parts.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    parts.append(block.get("text", ""))
    return " ".join(parts)


def _all_content_blocks(messages: list) -> list:
    blocks = []
    for msg in messages:
        content = msg.get("content", "")
        if isinstance(content, list):
            blocks.extend(content)
    return blocks


def detect_scenario(body: dict) -> str:
    messages = body.get("messages", [])
    blocks = _all_content_blocks(messages)

    # Multimodal signals are definitive
    if _has_audio(blocks):
        return "audio"
    if _has_video(blocks):
        return "video"

    text = _extract_text(messages)

    # Long document → longcontext
    if len(text) > LONG_CONTEXT_CHARS:
        return "longcontext"

    # Count signal strength for math vs coding vs ocr
    math_score = len(_MATH_PATTERNS.findall(text))
    code_score = len(_CODE_PATTERNS.findall(text))
    ocr_score = len(_OCR_PATTERNS.findall(text))

    scores = {"math": math_score, "coding": code_score, "ocr": ocr_score}
    best = max(scores, key=scores.get)

    if scores[best] > 0:
        return best

    # Default: coding (Qwen3.5-27B — best general-purpose)
    return "coding"


# ── Proxy helpers ─────────────────────────────────────────────────────────────

_TIMEOUT = httpx.Timeout(600.0, connect=10.0)
# TLS verification is on by default; disabled only when VERIFY_TLS=false is set for
# internal VPC traffic terminating on a self-signed certificate (see VERIFY_TLS above).
if not VERIFY_TLS:
    logger.warning(
        "TLS certificate verification is DISABLED (VERIFY_TLS=false). "
        "Only use this for internal VPC traffic with a self-signed upstream certificate."
    )
_CLIENT = httpx.AsyncClient(timeout=_TIMEOUT, verify=VERIFY_TLS)


async def _vllm_alias_is_warm(scenario: str) -> bool:
    """Probe the scenario alias's vLLM NLB /health directly with a short timeout.

    Returns True only when the alias is mapped AND its vLLM NLB answers /health with a
    2xx quickly. A cold alias (scaled to zero) has zero healthy NLB targets, so the probe
    fails fast (connection refused/reset or timeout) and we return False → the caller skips
    the gateway and goes straight to the Bedrock-direct fallback, turning a ~41s cold hang
    into ~2s. The vLLM endpoints are plain http on :8000 (internal NLB), so this probe does
    not depend on the gateway's TLS. Any unexpected error is treated as "not warm" but the
    request still has the reactive gateway fallback as a backstop.
    """
    base = VLLM_ENDPOINTS.get(scenario)
    if not base:
        return False  # alias not mapped → caller falls through to the gateway
    try:
        resp = await _CLIENT.get(f"{base.rstrip('/')}/health", timeout=_PREFLIGHT_TIMEOUT)
        return resp.status_code < 400
    except Exception as exc:  # noqa: BLE001 — connection refused/timeout = cold, expected
        logger.info(f"vLLM pre-flight: alias '{scenario}' cold ({exc!r})")
        return False


def _strip_cache_control(obj):
    """Recursively remove `cache_control` blocks (prompt caching) in place.

    Bedrock Claude 3.5 Sonnet 2024-06-20 returns "did not allow prompt caching"
    when cache_control is present. Claude Code attaches it to system blocks and
    large message content blocks. vLLM ignores it. Safe to drop on both paths.
    """
    if isinstance(obj, dict):
        obj.pop("cache_control", None)
        for v in obj.values():
            _strip_cache_control(v)
    elif isinstance(obj, list):
        for v in obj:
            _strip_cache_control(v)


def _sanitize_for_legacy_backend(body: dict) -> dict:
    """Down-convert a modern Anthropic Messages body for legacy backends.

    Verified minimal transform (against claude-cli/2.1.167 + Bedrock Claude 3.5
    Sonnet 2024-06-20) that turns a 400 "Malformed input request" into 200:
      1. drop top-level thinking / context_management / output_config
      2. convert mid-conversation messages[].role == "system" -> "user"
         (Bedrock allows only user/assistant in the messages array; the real
         system prompt already rides as the top-level `system` param)
      3. recursively strip cache_control (prompt caching unsupported)
    Top-level system / tools / metadata are kept — Bedrock accepts them.
    Returns the same dict (mutated in place) for convenience.
    """
    if not STRIP_LEGACY_FIELDS:
        return body
    for field in _LEGACY_TOP_LEVEL_FIELDS:
        body.pop(field, None)
    for msg in body.get("messages", []):
        if isinstance(msg, dict) and msg.get("role") == "system":
            msg["role"] = "user"
    _strip_cache_control(body)
    return body


def _rewrite_body(body: dict, scenario: str) -> dict:
    """Replace model field with detected scenario alias."""
    rewritten = dict(body)
    rewritten["model"] = scenario
    return rewritten


async def _proxy(request: Request, body: dict, scenario: str, allow_fallback: bool = False) -> Response:
    """Proxy to the gateway (vLLM via Higress), with optional Bedrock-direct fallback.

    When `allow_fallback` is set (only on /v1/messages, where Bedrock has a native
    Anthropic endpoint), a connection error to the gateway (cold vLLM = zero healthy
    NLB targets) or a gateway response with status >= 400 (e.g. context-window overflow)
    triggers `_bedrock_fallback`, which bypasses the gateway and calls Bedrock directly.
    """
    path = request.url.path
    url = f"{GATEWAY_BASE}{path}"

    headers = dict(request.headers)
    headers.pop("host", None)
    headers.pop("content-length", None)

    payload = json.dumps(body).encode()
    headers["content-length"] = str(len(payload))

    is_stream = body.get("stream", False)
    do_fallback = allow_fallback and FALLBACK_ENABLED

    # Cold-vLLM pre-flight: when the fallback is available and the target alias is mapped,
    # probe its vLLM NLB /health directly first. If it's cold (scaled to zero), skip the
    # gateway entirely and go straight to Bedrock — avoids Envoy's ~40s hang on a dead
    # upstream. Warm aliases fall through to the gateway as before; unmapped aliases (e.g.
    # an explicit Bedrock model) are never probed. The reactive fallback below still guards
    # against a gateway error on the warm path.
    if do_fallback and PREFLIGHT_VLLM_HEALTH and VLLM_ENDPOINTS.get(scenario):
        if not await _vllm_alias_is_warm(scenario):
            logger.info(f"vLLM pre-flight: '{scenario}' cold → Bedrock-direct (gateway bypassed)")
            return await _bedrock_fallback(body, is_stream=is_stream)

    if is_stream:
        # Use send(stream=True) so we can inspect the gateway's status code BEFORE
        # streaming its body — letting us fall back on a >= 400 without leaking a
        # partial gateway error to the client.
        if do_fallback:
            try:
                req = _CLIENT.build_request(
                    "POST", url, content=payload,
                    headers=headers, params=dict(request.query_params),
                )
                resp = await _CLIENT.send(req, stream=True)
            except httpx.TransportError as exc:
                logger.warning(f"gateway connection error ({exc!r}) → Bedrock-direct fallback")
                return await _bedrock_fallback(body, is_stream=True)
            if resp.status_code >= _FALLBACK_STATUS_MIN:
                logger.warning(f"gateway returned {resp.status_code} → Bedrock-direct fallback")
                await resp.aclose()
                return await _bedrock_fallback(body, is_stream=True)

            async def stream_gen():
                try:
                    async for chunk in resp.aiter_bytes():
                        yield chunk
                finally:
                    await resp.aclose()

            return StreamingResponse(stream_gen(), media_type="text/event-stream")

        async def stream_gen():
            async with _CLIENT.stream(
                "POST", url, content=payload,
                headers=headers, params=dict(request.query_params),
            ) as resp:
                async for chunk in resp.aiter_bytes():
                    yield chunk

        return StreamingResponse(stream_gen(), media_type="text/event-stream")
    else:
        if do_fallback:
            try:
                resp = await _CLIENT.post(
                    url, content=payload, headers=headers,
                    params=dict(request.query_params),
                )
            except httpx.TransportError as exc:
                logger.warning(f"gateway connection error ({exc!r}) → Bedrock-direct fallback")
                return await _bedrock_fallback(body, is_stream=False)
            if resp.status_code >= _FALLBACK_STATUS_MIN:
                logger.warning(f"gateway returned {resp.status_code} → Bedrock-direct fallback")
                return await _bedrock_fallback(body, is_stream=False)
            return Response(
                content=resp.content,
                status_code=resp.status_code,
                headers=dict(resp.headers),
            )

        resp = await _CLIENT.post(
            url, content=payload, headers=headers,
            params=dict(request.query_params),
        )
        return Response(
            content=resp.content,
            status_code=resp.status_code,
            headers=dict(resp.headers),
        )


# ── Routes ────────────────────────────────────────────────────────────────────

@app.get("/health/liveliness")
async def health():
    return {"status": "ok"}


@app.post("/v1/messages")
async def messages(request: Request):
    body = await request.json()

    # Down-convert modern 2.x fields so a cold vLLM alias can fall back to the
    # legacy Bedrock Sonnet without a 400. Lossless for warm vLLM too. Applied
    # on every alias (general AND direct) — any of them can hit the fallback.
    _sanitize_for_legacy_backend(body)

    # /v1/messages is the Anthropic-native path → Bedrock-direct fallback is allowed
    # here (Bedrock has a native Anthropic Messages endpoint; /v1/chat/completions
    # does not, so that route never falls back).
    model = body.get("model", "")
    if model != "general":
        # Non-general aliases pass straight through to the gateway
        return await _proxy(request, body, model, allow_fallback=True)

    scenario = detect_scenario(body)
    logger.info(f"general → {scenario} (model hint: {body.get('model')})")
    return await _proxy(request, _rewrite_body(body, scenario), scenario, allow_fallback=True)


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    body = await request.json()

    # No Bedrock-direct fallback here: Bedrock has no native OpenAI chat endpoint, and
    # adding an OpenAI<->Anthropic translation would re-introduce the very gateway
    # complexity this migration removes. /v1/chat/completions stays gateway-only.
    model = body.get("model", "")
    if model != "general":
        return await _proxy(request, body, model)

    scenario = detect_scenario(body)
    logger.info(f"general → {scenario}")
    return await _proxy(request, _rewrite_body(body, scenario), scenario)


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def passthrough(request: Request, path: str):
    """All other endpoints (e.g. /v1/models) pass through to the gateway."""
    url = f"{GATEWAY_BASE}/{path}"
    headers = dict(request.headers)
    headers.pop("host", None)

    body = await request.body()
    resp = await _CLIENT.request(
        request.method, url, content=body,
        headers=headers, params=dict(request.query_params),
    )
    return Response(content=resp.content, status_code=resp.status_code, headers=dict(resp.headers))

"""
Smart Router — NCT GenAI Gateway
Routes `general` alias requests to the best scenario alias based on
content analysis (MIME type > text rules > default=coding).

Architecture:
  Client → (general) → SmartRouter → LiteLLM (scenario alias: coding/math/video/...)
  Client → (coding/math/...) → LiteLLM directly (SmartRouter not in path)
"""
import os
import re
import httpx
import logging
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("smart-router")

app = FastAPI(title="NCT Smart Router")

LITELLM_BASE = os.environ["LITELLM_BASE_URL"].rstrip("/")  # e.g. http://internal-alb:4000

# TLS verification for the upstream LiteLLM endpoint. Defaults to enabled (secure).
# Set VERIFY_TLS=false ONLY for internal VPC traffic terminating on a self-signed
# certificate (e.g. an internal ALB without an ACM-issued public cert), where the
# network path is already constrained to the VPC CIDR by security groups.
VERIFY_TLS = os.environ.get("VERIFY_TLS", "true").lower() not in ("false", "0", "no")

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


def _rewrite_body(body: dict, scenario: str) -> dict:
    """Replace model field with detected scenario alias."""
    rewritten = dict(body)
    rewritten["model"] = scenario
    return rewritten


async def _proxy(request: Request, body: dict, scenario: str) -> Response:
    path = request.url.path
    url = f"{LITELLM_BASE}{path}"

    headers = dict(request.headers)
    headers.pop("host", None)
    headers.pop("content-length", None)

    import json
    payload = json.dumps(body).encode()
    headers["content-length"] = str(len(payload))

    is_stream = body.get("stream", False)

    if is_stream:
        async def stream_gen():
            async with _CLIENT.stream(
                "POST", url, content=payload,
                headers=headers, params=dict(request.query_params),
            ) as resp:
                async for chunk in resp.aiter_bytes():
                    yield chunk

        return StreamingResponse(stream_gen(), media_type="text/event-stream")
    else:
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
    import json
    body = await request.json()

    model = body.get("model", "")
    if model != "general":
        # Non-general aliases pass straight through to LiteLLM
        return await _proxy(request, body, model)

    scenario = detect_scenario(body)
    logger.info(f"general → {scenario} (model hint: {body.get('model')})")
    return await _proxy(request, _rewrite_body(body, scenario), scenario)


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    import json
    body = await request.json()

    model = body.get("model", "")
    if model != "general":
        return await _proxy(request, body, model)

    scenario = detect_scenario(body)
    logger.info(f"general → {scenario}")
    return await _proxy(request, _rewrite_body(body, scenario), scenario)


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE"])
async def passthrough(request: Request, path: str):
    """All other endpoints (e.g. /v1/models) pass through to LiteLLM."""
    url = f"{LITELLM_BASE}/{path}"
    headers = dict(request.headers)
    headers.pop("host", None)

    body = await request.body()
    resp = await _CLIENT.request(
        request.method, url, content=body,
        headers=headers, params=dict(request.query_params),
    )
    return Response(content=resp.content, status_code=resp.status_code, headers=dict(resp.headers))

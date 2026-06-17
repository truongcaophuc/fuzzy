"""STT Studio backend — proxy tới STT endpoint cấu hình được + post-ASR normalization.

Chạy: uvicorn app:app --port 8077 --reload
"""

from __future__ import annotations

import asyncio
import json
import time

import httpx
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from normalize import normalize_text
from rover import rover_merge

app = FastAPI(title="STT Studio")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
async def health():
    return {"ok": True}


@app.post("/api/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    endpoint: str = Form(...),          # vd https://api.openai.com/v1
    api_key: str = Form(""),
    model: str = Form("whisper-1"),
    language: str = Form(""),           # "vi" | "en" | "" (auto)
    prompt: str = Form(""),             # biasing/hotwords (brand/SKU...)
    catalog: str = Form("[]"),          # JSON array tên brand/SKU
    threshold: float = Form(80.0),
    use_unidecode: bool = Form(True),
    normalize: bool = Form(True),
):
    """Gửi audio tới STT endpoint (OpenAI-compatible) → transcript thô → chuẩn hoá."""
    audio = await file.read()
    url = endpoint.rstrip("/") + "/audio/transcriptions"

    data = {"model": model, "response_format": "json"}
    if language:
        data["language"] = language
    if prompt:
        data["prompt"] = prompt
    files = {"file": (file.filename or "audio.wav", audio, file.content_type or "audio/wav")}
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    t0 = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(url, data=data, files=files, headers=headers)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Không gọi được STT endpoint: {e}")
    latency_ms = round((time.perf_counter() - t0) * 1000)

    if r.status_code >= 400:
        raise HTTPException(r.status_code, f"STT endpoint lỗi: {r.text[:300]}")

    try:
        raw = r.json().get("text", "")
    except Exception:
        raw = r.text

    try:
        cat = json.loads(catalog) if catalog else []
        if not isinstance(cat, list):
            cat = []
    except json.JSONDecodeError:
        cat = []

    result = {"raw": raw, "normalized": raw, "matches": [], "latency_ms": latency_ms,
              "model": model, "endpoint": url}
    if normalize and cat:
        norm = normalize_text(raw, cat, threshold=threshold, use_unidecode=use_unidecode)
        result["normalized"] = norm["normalized"]
        result["matches"] = norm["matches"]
    return result


async def _call_asr(client: httpx.AsyncClient, audio: bytes, filename: str, ctype: str, asr: dict):
    """Gọi 1 ASR endpoint (OpenAI-compatible) → {name, raw, latency_ms, error?}."""
    name = asr.get("name") or asr.get("model") or "ASR"
    url = (asr.get("endpoint", "").rstrip("/")) + "/audio/transcriptions"
    data = {"model": asr.get("model", ""), "response_format": "json"}
    if asr.get("language"):
        data["language"] = asr["language"]
    if asr.get("prompt"):
        data["prompt"] = asr["prompt"]
    headers = {"Authorization": f"Bearer {asr['api_key']}"} if asr.get("api_key") else {}
    files = {"file": (filename, audio, ctype)}
    t0 = time.perf_counter()
    try:
        r = await client.post(url, data=data, files=files, headers=headers, timeout=120)
        ms = round((time.perf_counter() - t0) * 1000)
        if r.status_code >= 400:
            return {"name": name, "raw": "", "latency_ms": ms, "error": f"HTTP {r.status_code}: {r.text[:200]}"}
        try:
            raw = r.json().get("text", "")
        except Exception:
            raw = r.text
        return {"name": name, "raw": raw, "latency_ms": ms}
    except httpx.HTTPError as e:
        return {"name": name, "raw": "", "latency_ms": round((time.perf_counter() - t0) * 1000), "error": str(e)}


@app.post("/api/transcribe_multi")
async def transcribe_multi(
    file: UploadFile = File(...),
    asrs: str = Form("[]"),             # JSON: [{name,endpoint,model,api_key,language,prompt}]
    catalog: str = Form("[]"),
    threshold: float = Form(80.0),
    use_unidecode: bool = Form(True),
    normalize: bool = Form(True),
):
    """Gọi SONG SONG nhiều ASR → chuẩn hoá fuzzy TỪNG bản → gộp."""
    audio = await file.read()
    fname = file.filename or "audio.wav"
    ctype = file.content_type or "audio/wav"
    try:
        asr_list = json.loads(asrs) or []
    except json.JSONDecodeError:
        asr_list = []
    try:
        cat = json.loads(catalog) or []
    except json.JSONDecodeError:
        cat = []
    if not isinstance(cat, list):
        cat = []

    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*[
            _call_asr(client, audio, fname, ctype, a) for a in asr_list
        ])

    # Chuẩn hoá fuzzy cho TỪNG bản
    for res in results:
        if normalize and cat and res.get("raw"):
            norm = normalize_text(res["raw"], cat, threshold=threshold, use_unidecode=use_unidecode)
            res["normalized"] = norm["normalized"]
            res["matches"] = norm["matches"]
        else:
            res["normalized"] = res.get("raw", "")
            res["matches"] = []

    # Gộp bằng ROVER (bỏ phiếu từng từ, trọng số theo tổng điểm brand/SKU)
    ok = [r for r in results if not r.get("error") and r.get("normalized")]
    merged = {"text": "", "agreed": False, "method": "ROVER", "primary": None}
    if len(ok) == 1:
        merged = {"text": ok[0]["normalized"], "agreed": True, "method": "1 ASR", "primary": ok[0]["name"]}
    elif ok:
        # sắp theo trọng số giảm dần (hệ nhiều brand/SKU khớp = đáng tin hơn → phá hoà phiếu)
        order = sorted(ok, key=lambda r: sum(m["score"] for m in r.get("matches", [])), reverse=True)
        token_lists = [r["normalized"].split() for r in order]
        weights = [1.0 + sum(m["score"] for m in r.get("matches", [])) / 1000 for r in order]
        rover_text = " ".join(rover_merge(token_lists, weights))
        agreed = len({r["normalized"].strip().lower() for r in ok}) == 1
        merged = {"text": rover_text, "agreed": agreed,
                  "method": "ROVER (bỏ phiếu từng từ)", "primary": order[0]["name"]}

    return {"results": results, "merged": merged}


@app.post("/api/normalize")
async def normalize_only(payload: dict):
    """Test riêng phần fuzzy (không cần audio): {text, catalog, threshold, use_unidecode}."""
    return normalize_text(
        payload.get("text", ""),
        payload.get("catalog", []),
        threshold=float(payload.get("threshold", 80.0)),
        use_unidecode=bool(payload.get("use_unidecode", True)),
    )

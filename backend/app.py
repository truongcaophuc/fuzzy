"""STT Studio backend — proxy tới STT endpoint cấu hình được + post-ASR normalization.

Chạy: uvicorn app:app --port 8077 --reload
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import subprocess
import tempfile
import time

import httpx
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from normalize import normalize_text, best_match_score
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


def _normalize_results(results, cat, alias_map, threshold, use_unidecode, use_phonetic, normalize):
    """Chuẩn hoá fuzzy + alias cho TỪNG bản ASR (sửa results tại chỗ)."""
    for res in results:
        if normalize and (cat or alias_map) and res.get("raw"):
            norm = normalize_text(res["raw"], cat, threshold=threshold,
                                  use_unidecode=use_unidecode, aliases=alias_map, use_phonetic=use_phonetic)
            res["normalized"] = norm["normalized"]
            res["matches"] = norm["matches"]
        else:
            res["normalized"] = res.get("raw", "")
            res["matches"] = []
    return results


def _merge_results(results):
    """Gộp nhiều bản ASR đã chuẩn hoá → ROVER bỏ phiếu từng từ (trọng số theo điểm khớp)."""
    ok = [r for r in results if not r.get("error") and r.get("normalized")]
    if len(ok) == 1:
        return {"text": ok[0]["normalized"], "agreed": True, "method": "1 ASR", "primary": ok[0]["name"]}
    if not ok:
        return {"text": "", "agreed": False, "method": "ROVER", "primary": None}
    order = sorted(ok, key=lambda r: sum(m["score"] for m in r.get("matches", [])), reverse=True)
    token_lists = [r["normalized"].split() for r in order]
    weights = [1.0 + sum(m["score"] for m in r.get("matches", [])) / 1000 for r in order]
    rover_text = " ".join(rover_merge(token_lists, weights))
    agreed = len({r["normalized"].strip().lower() for r in ok}) == 1
    return {"text": rover_text, "agreed": agreed,
            "method": "ROVER (bỏ phiếu từng từ)", "primary": order[0]["name"]}


@app.post("/api/transcribe_multi")
async def transcribe_multi(
    file: UploadFile = File(...),
    asrs: str = Form("[]"),             # JSON: [{name,endpoint,model,api_key,language,prompt}]
    catalog: str = Form("[]"),
    aliases: str = Form("{}"),          # JSON: {"bọt tre":"Porsche", ...} (cách đọc lơ lớ → tên chuẩn)
    threshold: float = Form(80.0),
    use_unidecode: bool = Form(True),
    use_phonetic: bool = Form(True),
    normalize: bool = Form(True),
):
    """Gọi SONG SONG nhiều ASR → chuẩn hoá fuzzy + alias TỪNG bản → gộp."""
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
    try:
        alias_map = json.loads(aliases) or {}
    except json.JSONDecodeError:
        alias_map = {}
    if not isinstance(alias_map, dict):
        alias_map = {}

    async with httpx.AsyncClient() as client:
        results = await asyncio.gather(*[
            _call_asr(client, audio, fname, ctype, a) for a in asr_list
        ])

    _normalize_results(results, cat, alias_map, threshold, use_unidecode, use_phonetic, normalize)
    merged = _merge_results(results)
    return {"results": results, "merged": merged}


@app.post("/api/normalize")
async def normalize_only(payload: dict):
    """Test riêng phần fuzzy (không cần audio): {text, catalog, threshold, use_unidecode}."""
    return normalize_text(
        payload.get("text", ""),
        payload.get("catalog", []),
        threshold=float(payload.get("threshold", 80.0)),
        use_unidecode=bool(payload.get("use_unidecode", True)),
        aliases=payload.get("aliases") or {},
        use_phonetic=bool(payload.get("use_phonetic", True)),
    )


# ============ TTS (popthink / OmniVoice) + AUTO-TEST (TTS → STT → chấm điểm) ============

def _tts_url(base_url: str) -> str:
    base = (base_url or "http://10.120.80.116:6655").rstrip("/")
    return base + "/audio/speech" if base.endswith("/v1") else base + "/v1/audio/speech"


def _atempo_chain(speed: float) -> str:
    """ffmpeg atempo chỉ nhận 0.5–2.0/bộ lọc → chuỗi nhiều bộ cho ngoài khoảng."""
    factors = []
    s = speed
    while s > 2.0:
        factors.append(2.0); s /= 2.0
    while s < 0.5:
        factors.append(0.5); s /= 0.5
    factors.append(s)
    return ",".join(f"atempo={f:.4f}" for f in factors)


def _time_stretch(audio: bytes, speed: float) -> bytes:
    """Đổi TỐC ĐỘ audio (giữ cao độ) bằng ffmpeg atempo. speed=1 → giữ nguyên."""
    if not speed or abs(speed - 1.0) < 1e-3:
        return audio
    try:
        with tempfile.TemporaryDirectory() as d:
            ip = os.path.join(d, "in.wav"); op = os.path.join(d, "out.wav")
            with open(ip, "wb") as f:
                f.write(audio)
            p = subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                 "-i", ip, "-filter:a", _atempo_chain(speed), op],
                capture_output=True, timeout=30,
            )
            if p.returncode == 0 and os.path.exists(op):
                with open(op, "rb") as f:
                    return f.read()
    except Exception:
        pass
    return audio  # ffmpeg lỗi/thiếu → giữ nguyên


async def _call_tts(client: httpx.AsyncClient, tts: dict, text: str) -> bytes:
    """Gọi popthink/OmniVoice TTS (OpenAI-compatible /audio/speech) → WAV bytes.
    Server bỏ qua `speed` → ta tự time-stretch bằng ffmpeg để đổi tốc độ THẬT (gửi STT)."""
    body = {
        "model": tts.get("model") or "omnivoice",
        "voice": tts.get("voice") or "nu_ai",
        "input": text,
        "response_format": "wav",
    }
    if tts.get("num_step"):
        body["num_step"] = int(tts["num_step"])
    r = await client.post(_tts_url(tts.get("base_url", "")), json=body, timeout=90)
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:150]}")
    speed = float(tts.get("speed", 1) or 1)
    if abs(speed - 1.0) >= 1e-3:
        return await asyncio.to_thread(_time_stretch, r.content, speed)
    return r.content


def _strip_key(s: str) -> str:
    """Khoá so khớp 'có chứa không': bỏ dấu + thường + bỏ ký tự không phải chữ/số."""
    from normalize import _norm
    t = _norm(s or "", True)
    return "".join(ch for ch in t if ch.isalnum() or ch == " ").strip()


def _check_pass(expected: str, results: list, merged: dict) -> tuple[bool, list]:
    """expected (brand) có xuất hiện trong bản chuẩn hoá nào không (bỏ dấu, không phân biệt hoa thường)."""
    exp = _strip_key(expected)
    if not exp:
        return (False, [])
    matched_in = []
    for r in results:
        if exp in _strip_key(r.get("normalized", "")):
            matched_in.append(r.get("name", "ASR"))
    if merged and exp in _strip_key(merged.get("text", "")):
        matched_in.append("merged")
    return (len(matched_in) > 0, matched_in)


@app.post("/api/tts")
async def tts_preview(payload: dict):
    """Gen audio từ 1 đoạn text (nghe thử). Trả {audio_b64}."""
    text = (payload.get("text") or "").strip()
    if not text:
        raise HTTPException(400, "Thiếu text")
    async with httpx.AsyncClient() as client:
        try:
            audio = await _call_tts(client, payload.get("tts", {}), text)
        except Exception as e:
            raise HTTPException(502, f"TTS lỗi: {e}")
    return {"audio_b64": base64.b64encode(audio).decode()}


@app.post("/api/autotest")
async def autotest(payload: dict):
    """Pipeline test tự động: với mỗi item {expected, text}: TTS(text) → multi-ASR → chuẩn hoá
    → so với 'expected' → đúng/sai. Trả {items:[...], summary:{total,passed,pass_rate}}."""
    tts = payload.get("tts", {})
    asr_list = payload.get("asrs") or []
    cat = payload.get("catalog") or []
    if not isinstance(cat, list):
        cat = []
    alias_map = payload.get("aliases") or {}
    if not isinstance(alias_map, dict):
        alias_map = {}
    threshold = float(payload.get("threshold", 80.0))
    use_unidecode = bool(payload.get("use_unidecode", True))
    use_phonetic = bool(payload.get("use_phonetic", True))
    normalize = bool(payload.get("normalize", True))
    include_audio = bool(payload.get("include_audio", True))
    items = payload.get("items") or []
    sem = asyncio.Semaphore(int(payload.get("concurrency", 4)))

    async with httpx.AsyncClient() as client:
        async def run_item(item):
            async with sem:
                expected = (item.get("expected") or "").strip()
                text = (item.get("text") or "").strip()
                base = {"expected": expected, "text": text}
                try:
                    audio = await _call_tts(client, tts, text)
                except Exception as e:
                    return {**base, "error": f"TTS: {e}", "results": [], "merged": None,
                            "pass": False, "matched_in": []}
                results = await asyncio.gather(*[
                    _call_asr(client, audio, "a.wav", "audio/wav", a) for a in asr_list
                ])
                results = [dict(r) for r in results]
                _normalize_results(results, cat, alias_map, threshold, use_unidecode, use_phonetic, normalize)
                # điểm fuzzy của brand kỳ vọng vs bản THÔ từng ASR (độ gần âm học thật,
                # không tính trên bản đã chuẩn hoá để PASS không bị =100 giả tạo)
                for res in results:
                    res["expected_score"] = best_match_score(res.get("raw", ""), expected, use_unidecode, use_phonetic)
                best_score = max((r["expected_score"] for r in results), default=0.0)
                merged = _merge_results(results)
                passed, matched_in = _check_pass(expected, results, merged)
                out = {**base, "results": results, "merged": merged,
                       "pass": passed, "matched_in": matched_in, "best_score": best_score}
                if include_audio:
                    out["audio_b64"] = base64.b64encode(audio).decode()
                return out

        item_results = await asyncio.gather(*[run_item(it) for it in items])

    total = len(item_results)
    passed = sum(1 for r in item_results if r.get("pass"))
    return {"items": item_results,
            "summary": {"total": total, "passed": passed,
                        "pass_rate": round(100 * passed / total, 1) if total else 0.0}}

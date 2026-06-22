"""STT Studio backend — proxy tới STT endpoint cấu hình được + post-ASR normalization.

Chạy: uvicorn app:app --port 8077 --reload
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import subprocess
import tempfile
import time

import uuid
from collections import deque

import httpx
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from normalize import (normalize_text, best_match_score, get_candidates,
                       _key, _SHORT_SPAN_MAXLEN, _SHORT_SPAN_MIN)
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


# ============ DEMO: SAP warm-handoff receiver (nhận handoff ấm từ Dograh) ============
# Dograh node "Transfer Call" (Warm handoff) POST gói ngữ cảnh tới /api/handoff khi
# bắt đầu chuyển máy. Ta lưu lại + đẩy real-time (SSE) cho màn hình SAP đang mở, để
# điện thoại viên thấy tóm tắt/transcript TRƯỚC khi nhấc máy.

_HANDOFFS: deque = deque(maxlen=50)            # lịch sử handoff gần nhất (mới → cũ)
_HANDOFF_SUBS: set[asyncio.Queue] = set()      # subscribers SSE đang mở


@app.post("/api/handoff")
async def receive_handoff(request: Request):
    """Nhận gói warm-handoff từ Dograh (payload tuỳ cấu hình node Transfer)."""
    try:
        payload = await request.json()
    except Exception:
        body = await request.body()
        payload = {"raw": body.decode("utf-8", "ignore")}
    if not isinstance(payload, dict):
        payload = {"data": payload}

    event = {
        "id": uuid.uuid4().hex[:12],
        "received_at": time.time(),
        "payload": payload,
    }
    _HANDOFFS.appendleft(event)
    for q in list(_HANDOFF_SUBS):              # fan-out, không chặn nếu queue đầy
        try:
            q.put_nowait(event)
        except asyncio.QueueFull:
            pass
    return {"ok": True, "id": event["id"]}


@app.get("/api/handoff/list")
async def list_handoffs():
    """Lịch sử handoff gần nhất (mới → cũ) — để màn hình SAP nạp lúc mở."""
    return {"items": list(_HANDOFFS)}


@app.get("/api/handoff/stream")
async def stream_handoffs(request: Request):
    """SSE: đẩy handoff mới tới màn hình SAP ngay khi nhận (screen-pop)."""
    q: asyncio.Queue = asyncio.Queue(maxsize=100)
    _HANDOFF_SUBS.add(q)

    async def gen():
        try:
            yield ": connected\n\n"
            while True:
                if await request.is_disconnected():
                    break
                try:
                    event = await asyncio.wait_for(q.get(), timeout=15.0)
                    yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"     # giữ kết nối qua proxy
        finally:
            _HANDOFF_SUBS.discard(q)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


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
    llm: str = Form("{}"),              # JSON: {base_url,model,api_key}
    use_llm: bool = Form(False),
    llm_mode: str = Form("smart"),      # 'smart' | 'verify'
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
    committed_text = merged["text"]            # bản auto-chốt (có catalog matches)
    merged_raw = _merge_results([{**r, "normalized": r.get("raw", "")} for r in results])["text"]

    def _hold_merge():
        """Bản KHÔNG chốt catalog: giữ alias (khai tay, luôn tin), revert phần catalog về thô."""
        held = []
        for res in results:
            raw = res.get("raw", "")
            if alias_map:
                an = normalize_text(raw, [], threshold=threshold, use_unidecode=use_unidecode,
                                    aliases=alias_map, use_phonetic=use_phonetic)
                held.append({**res, "normalized": an["normalized"], "matches": an["matches"]})
            else:
                held.append({**res, "normalized": raw, "matches": []})
        return held

    # GATING (đồng bộ với Auto Test): chưa chắc → KHÔNG tự-sửa, chỉ đề xuất ứng viên.
    candidates: list = []
    llm_action = "skip"
    hold_base = merged_raw
    if normalize and cat:
        cmap: dict = {}
        for res in results:
            for cc in get_candidates(res.get("raw", ""), cat, top_k=3, floor=_LLM_FLOOR,
                                     use_unidecode=use_unidecode, use_phonetic=use_phonetic):
                if cc["score"] > cmap.get(cc["brand"], {"score": -1.0})["score"]:
                    cmap[cc["brand"]] = cc
        candidates = sorted(cmap.values(), key=lambda x: -x["score"])[:3]
        llm_action, _ = _decide_llm(candidates, threshold)
        held = _hold_merge()
        hold_base = _merge_results(held)["text"]
        if llm_action != "auto":               # held → cập nhật per-ASR results để hiển thị
            for res, h in zip(results, held):
                res["normalized"], res["matches"] = h["normalized"], h["matches"]

    # LLM arbiter: 'smart' chỉ ca chưa-chắc; 'verify' kiểm cả ca auto (đồng âm điểm cao)
    try:
        llm_cfg = json.loads(llm) or {}
    except json.JSONDecodeError:
        llm_cfg = {}
    merged_final, llm_pick, llm_note = await _resolve_with_llm(
        merged_raw, hold_base, committed_text, llm_action, candidates, llm_cfg, use_llm, llm_mode)
    merged = {**merged, "text": merged_final}

    return {"results": results, "merged": merged, "merged_raw": merged_raw,
            "candidates": candidates, "llm_action": llm_action,
            "llm_pick": llm_pick, "llm_note": llm_note}


@app.post("/api/fuzzy_text")
async def fuzzy_text(payload: dict):
    """Tính fuzzy cho TEXT gõ tay (không cần audio) — như khi STT ra chuỗi này.
    Trả: fuzzy thô (normalize), ứng viên (lọc), gating, câu cuối (đã gate, giữ alias)."""
    text = (payload.get("text") or "").strip()
    cat = payload.get("catalog") or []
    if not isinstance(cat, list):
        cat = []
    alias_map = payload.get("aliases") or {}
    if not isinstance(alias_map, dict):
        alias_map = {}
    threshold = float(payload.get("threshold", 70.0))
    use_unidecode = bool(payload.get("use_unidecode", True))
    use_phonetic = bool(payload.get("use_phonetic", True))

    norm = normalize_text(text, cat, threshold=threshold, use_unidecode=use_unidecode,
                          aliases=alias_map, use_phonetic=use_phonetic)
    candidates = get_candidates(text, cat, top_k=5, floor=_LLM_FLOOR,
                                use_unidecode=use_unidecode, use_phonetic=use_phonetic)
    llm_action, reason = _decide_llm(candidates, threshold)
    committed = norm["normalized"]
    hold_base = (normalize_text(text, [], threshold=threshold, use_unidecode=use_unidecode,
                                aliases=alias_map, use_phonetic=use_phonetic)["normalized"]
                 if alias_map else text)
    # LLM arbiter: 'smart' chỉ ca chưa-chắc; 'verify' kiểm cả ca auto (bắt đồng âm điểm cao)
    llm = payload.get("llm") or {}
    use_llm = bool(payload.get("use_llm"))
    llm_mode = payload.get("llm_mode", "smart")
    final, llm_pick, llm_note = await _resolve_with_llm(
        text, hold_base, committed, llm_action, candidates, llm, use_llm, llm_mode)
    return {"raw": text, "fuzzy": norm["normalized"], "matches": norm["matches"],
            "candidates": candidates, "llm_action": llm_action, "reason": reason, "final": final,
            "llm_pick": llm_pick, "llm_note": llm_note}


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


# ============ LLM ARBITER: fuzzy mớm ứng viên → LLM quyết theo ngữ cảnh ============

_LLM_AUTO_HIGH = 75.0   # ≥ ngưỡng này + cách biệt rõ → tin fuzzy luôn, KHỎI gọi LLM
_LLM_MARGIN = 12.0      # cách biệt #1 với #2 để coi là "chắc"
_LLM_FLOOR = 50.0       # dưới ngưỡng này coi như không có ứng viên brand


def _decide_llm(cands: list[dict], auto_high: float = _LLM_AUTO_HIGH) -> tuple[str, str]:
    """Quyết có cần gọi LLM không dựa trên ứng viên fuzzy.
    auto_high = ngưỡng auto-commit (mặc định = ngưỡng fuzzy của request, để 2 ngưỡng bằng nhau).
    Trả (action, reason): action ∈ {skip, auto, llm}."""
    if not cands:
        return ("skip", "không có ứng viên ≥ floor → không có brand")
    top = cands[0]["score"]
    second = cands[1]["score"] if len(cands) > 1 else 0.0
    # Span ngắn (<4 ký tự, brand ngắn Fox/KFC/DHL) chỉ AUTO khi GẦN-KHÍT ≥90 — chống đồng âm
    # ("phở"→Fox 80 vẫn là ỨNG VIÊN cho LLM, nhưng KHÔNG tự commit). Span dài: ngưỡng auto_high bình thường.
    eff_high = auto_high
    if len(_key(cands[0].get("span", ""), True)) < _SHORT_SPAN_MAXLEN:
        eff_high = max(auto_high, _SHORT_SPAN_MIN)
    if top >= eff_high and (len(cands) == 1 or top - second >= _LLM_MARGIN):
        return ("auto", f"fuzzy chắc ({top} ≥ {eff_high}, cách biệt rõ) → khỏi LLM")
    return ("llm", f"fuzzy không chắc (top {top}, #2 {second}, ngưỡng auto {eff_high}) → cần LLM")


async def _call_llm_chat(llm: dict, system: str, user: str) -> str:
    base = (llm.get("base_url") or "").rstrip("/")
    if not base:
        raise HTTPException(400, "Thiếu LLM base_url")
    url = base + "/chat/completions" if base.endswith("/v1") else base + "/v1/chat/completions"
    body = {
        "model": llm.get("model") or "default",
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0,
    }
    headers = {"Authorization": f"Bearer {llm['api_key']}"} if llm.get("api_key") else {}
    async with httpx.AsyncClient(timeout=60) as client:
        try:
            r = await client.post(url, json=body, headers=headers)
        except httpx.HTTPError as e:
            raise HTTPException(502, f"Không gọi được LLM: {e}")
    if r.status_code >= 400:
        raise HTTPException(r.status_code, f"LLM lỗi: {r.text[:300]}")
    try:
        return r.json()["choices"][0]["message"]["content"].strip()
    except Exception:
        return r.text.strip()


def _build_llm_prompt(transcripts: list[dict], cands: list[dict], catalog: list[str]) -> tuple[str, str]:
    system = (
        "Bạn là bộ sửa tên thương hiệu cho transcript tiếng Việt từ hệ STT. Người Việt đọc brand "
        "tiếng Anh 'lơ lớ' nên STT ghi sai chính tả. Dựa NGỮ CẢNH câu, sửa cụm bị nghe-sai thành "
        "đúng tên brand trong CATALOG. Quy tắc: (1) chỉ sửa khi ngữ cảnh hợp lý; (2) TUYỆT ĐỐI "
        "không bịa brand ngoài catalog; (3) cụm nào không phải brand thì GIỮ NGUYÊN; (4) trả về "
        "DUY NHẤT câu đã sửa, không thêm giải thích."
    )
    asr = "\n".join(f"- {t.get('name','ASR')}: {t.get('text','')}" for t in transcripts) or "- (trống)"
    cand = "\n".join(
        f"- {c['brand']} (gần cụm \"{c.get('span','')}\", điểm {c.get('score')})" for c in cands
    ) or "- (không có gợi ý mạnh)"
    user = (
        f"Transcript từ các ASR:\n{asr}\n\n"
        f"Ứng viên brand (GỢI Ý từ fuzzy, CHƯA chắc đúng):\n{cand}\n\n"
        f"CATALOG brand hợp lệ: {', '.join(catalog)}\n\n"
        "Trả về câu đã sửa tên brand (giữ nguyên phần còn lại):"
    )
    return system, user


_ARBITER_SYS = (
    "Bạn chọn TÊN BRAND đúng từ DANH SÁCH ỨNG VIÊN cho 1 câu STT tiếng Việt, hoặc trả null nếu câu "
    "chỉ là tiếng Việt thường (đồng âm, KHÔNG nhắc tới brand nào). CHỈ trả JSON thuần "
    "{\"brand\": <tên ĐÚNG NGUYÊN VĂN trong ứng viên> hoặc null}, không markdown, không giải thích.\n"
    'VD: câu "sáng nay ăn phở bò", ứng viên ["Fox","Ford"] -> {"brand": null}\n'
    'VD: câu "tôi muốn mua Fox", ứng viên ["Fox"] -> {"brand": "Fox"}\n'
    'VD: câu "tôi qua mặt được nó", ứng viên ["Walmart"] -> {"brand": null}\n'
    'VD: câu "đặt giúp tôi cốc cô ca", ứng viên ["Coca-Cola"] -> {"brand": "Coca-Cola"}'
)


def _parse_brand_json(text: str) -> str | None:
    """Lấy giá trị brand từ output LLM, kể cả khi bọc ```json fence hay kèm chữ thừa."""
    m = re.search(r"\{[^{}]*\}", text or "", re.DOTALL)
    if not m:
        return None
    try:
        b = json.loads(m.group(0)).get("brand")
    except Exception:
        return None
    return b.strip() if isinstance(b, str) and b.strip() and b.strip().lower() != "null" else None


async def _llm_arbiter(primary: str, cands: list[dict], llm: dict) -> tuple[str | None, str]:
    """LLM chọn brand đúng từ ứng viên theo ngữ cảnh, hoặc None. Trả (brand|None, raw_output)."""
    brands = [c["brand"] for c in cands]
    out = await _call_llm_chat(llm, _ARBITER_SYS, f'câu: "{primary}"\nứng viên: {brands}')
    brand = _parse_brand_json(out)
    if brand and brand not in brands:                       # khớp lại không phân biệt hoa/thường
        brand = next((b for b in brands if b.lower() == brand.lower()), None)
    return brand, out


def _apply_brand(primary: str, cands: list[dict], brand: str) -> str:
    """Thay cụm span của brand được chọn vào câu (1 lần)."""
    c = next((c for c in cands if c["brand"] == brand), None)
    return primary.replace(c["span"], brand, 1) if c and c.get("span") else primary


async def _resolve_with_llm(raw: str, hold_base: str, committed: str, action: str,
                            cands: list[dict], llm: dict, use_llm: bool,
                            mode: str = "smart") -> tuple[str, str | None, str | None]:
    """Áp LLM arbiter theo mode. Trả (final, llm_pick, llm_note).
    - hold_base = câu khi KHÔNG chốt (raw / alias-applied);  committed = câu khi auto-chốt.
    - mode 'smart' : LLM chỉ xử ca 'llm' (chưa chắc); ca 'auto' chốt thẳng KHÔNG hỏi LLM.
    - mode 'verify': LLM xử CẢ ca 'auto' lẫn 'llm' (bắt được đồng âm điểm cao như qua mặt→Walmart 83).
      pick → áp brand lên hold_base; null → hold_base (revert kể cả auto)."""
    default = committed if action == "auto" else hold_base
    if not use_llm or not llm.get("base_url") or action == "skip" or not cands:
        return default, None, None
    if mode != "verify" and action != "llm":     # smart: bỏ qua ca auto
        return default, None, None
    try:
        pick, _ = await _llm_arbiter(raw, cands, llm)
    except Exception as e:
        return default, None, f"LLM lỗi: {str(e)[:120]}"
    if pick:
        return _apply_brand(hold_base, cands, pick), pick, None
    return hold_base, None, "LLM: không brand → giữ nguyên"


@app.post("/api/llm_correct")
async def llm_correct(payload: dict):
    """Mớm ứng viên fuzzy + raw cho LLM để quyết theo ngữ cảnh.
    Body: {transcripts:[{name,text}], catalog:[], llm:{base_url,model,api_key}, mode, top_k}.
    mode: 'smart' (chỉ gọi LLM khi fuzzy không chắc) | 'always'. Trả {action, corrected, candidates}."""
    transcripts = payload.get("transcripts") or []
    cat = payload.get("catalog") or []
    if not isinstance(cat, list):
        cat = []
    llm = payload.get("llm") or {}
    mode = payload.get("mode", "smart")
    top_k = int(payload.get("top_k", 5))
    primary = (payload.get("text") or (transcripts[0]["text"] if transcripts else "")).strip()
    if not transcripts and primary:
        transcripts = [{"name": "ASR", "text": primary}]

    # gom ứng viên từ TẤT CẢ transcript (dedupe theo brand, giữ điểm cao nhất)
    merged: dict[str, dict] = {}
    for t in transcripts:
        for c in get_candidates(t.get("text", ""), cat, top_k=top_k, floor=_LLM_FLOOR):
            if c["score"] > merged.get(c["brand"], {"score": -1})["score"]:
                merged[c["brand"]] = c
    cands = sorted(merged.values(), key=lambda x: -x["score"])[:top_k]

    action, reason = _decide_llm(cands)
    if mode == "always" and action != "skip":
        action = "llm"

    if action == "skip":
        return {"action": "skip", "reason": reason, "corrected": primary, "candidates": cands}
    if action == "auto":
        # tin fuzzy: thay cụm ứng viên #1 vào (qua normalize_text với catalog)
        norm = normalize_text(primary, cat, threshold=70, aliases=None, use_phonetic=True)
        return {"action": "auto", "reason": reason, "corrected": norm["normalized"], "candidates": cands}

    system, user = _build_llm_prompt(transcripts, cands, cat)
    corrected = await _call_llm_chat(llm, system, user)
    return {"action": "llm", "reason": reason, "corrected": corrected, "candidates": cands}


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
    llm_cfg = payload.get("llm") or {}
    use_llm = bool(payload.get("use_llm"))
    llm_mode = payload.get("llm_mode", "smart")
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
                # điểm fuzzy của brand kỳ vọng vs bản THÔ từng ASR — DÙNG ĐƯỜNG CÓ LỌC
                # (length/biên/nhóm-âm-đầu) để đồng bộ với ứng viên: cửa sổ bị lọc → điểm 0,
                # tránh "phở vs Fox = 80" giả do ph→f trên cửa sổ 3 ký tự.
                for res in results:
                    ec = get_candidates(res.get("raw", ""), [expected], top_k=1, floor=0.0,
                                        use_unidecode=use_unidecode, use_phonetic=use_phonetic)
                    res["expected_score"] = ec[0]["score"] if ec else 0.0
                best_score = max((r["expected_score"] for r in results), default=0.0)
                merged = _merge_results(results)
                merged_raw = _merge_results([{**r, "normalized": r.get("raw", "")} for r in results])["text"]
                # ứng viên fuzzy (top-3, đã lọc biên + nhóm-âm-đầu) + quyết định gating
                cmap: dict = {}
                for res in results:
                    for cc in get_candidates(res.get("raw", ""), cat, top_k=3, floor=_LLM_FLOOR):
                        if cc["score"] > cmap.get(cc["brand"], {"score": -1.0})["score"]:
                            cmap[cc["brand"]] = cc
                candidates = sorted(cmap.values(), key=lambda x: -x["score"])[:3]
                llm_action, _ = _decide_llm(candidates, threshold)
                # ĐỒNG BỘ: chỉ "chốt" brand vào merged khi fuzzy CHẮC (auto, cách biệt rõ).
                # Vùng chưa-chắc → merged giữ THÔ; chỉ "đề xuất" khi CÓ ứng viên qua lọc
                # (tránh phantom: normalize commit "phở"→Fox mà candidate đã loại vì cửa sổ ngắn).
                fuzzy_suggest = merged["text"] if (candidates and merged["text"] != merged_raw) else None
                committed_text = merged["text"]   # bản auto-chốt (trước khi gate/LLM)
                # gate + LLM arbiter: smart→giữ thô khi chưa chắc; verify→LLM kiểm cả ca auto
                m_final, llm_pick, llm_note = await _resolve_with_llm(
                    merged_raw, merged_raw, committed_text, llm_action, candidates, llm_cfg, use_llm, llm_mode)
                merged = {**merged, "text": m_final}
                # pass = brand kỳ vọng có trong merged ĐÃ chốt (đồng bộ với hiển thị)
                exp_key = _strip_key(expected)
                passed = bool(exp_key) and exp_key in _strip_key(merged["text"])
                matched_in = [r["name"] for r in results if exp_key and exp_key in _strip_key(r.get("normalized", ""))]
                if passed and "merged" not in matched_in:
                    matched_in.append("merged")
                out = {**base, "results": results, "merged": merged, "merged_raw": merged_raw,
                       "fuzzy_suggest": fuzzy_suggest, "pass": passed, "matched_in": matched_in,
                       "best_score": best_score, "candidates": candidates, "llm_action": llm_action,
                       "llm_pick": llm_pick, "llm_note": llm_note}
                if include_audio:
                    out["audio_b64"] = base64.b64encode(audio).decode()
                return out

        item_results = await asyncio.gather(*[run_item(it) for it in items])

    total = len(item_results)
    passed = sum(1 for r in item_results if r.get("pass"))
    return {"items": item_results,
            "summary": {"total": total, "passed": passed,
                        "pass_rate": round(100 * passed / total, 1) if total else 0.0}}

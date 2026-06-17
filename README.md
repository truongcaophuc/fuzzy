# STT Studio · Multi-ASR

Công cụ demo/thử nghiệm **nhiều STT song song (cấu hình model được)** + **hậu xử lý fuzzy** (sửa tên brand/SKU sau ASR bằng `rapidfuzz` + `unidecode`, **áp cho TỪNG bản**) + **gộp**. Phục vụ chuẩn bị RFP AI Call Center (mục C3.01–C3.04).

## Multi-ASR
- Cấu hình **nhiều ASR** (add/remove), mỗi cái: endpoint OpenAI-compatible `/v1`, model, ngôn ngữ, API key.
- Backend gọi **song song** tất cả ASR → chuẩn hoá fuzzy **từng bản** → **gộp**:
  - các bản giống nhau → 1 kết quả (đồng nhất);
  - khác nhau → chọn bản có **tổng điểm brand/SKU cao nhất** (sạch & khớp nhất).
- Đã test 2 endpoint nội bộ: `gipformer` (10.120.60.211:8910) + `Qwen3-ASR` (10.120.80.116:8801) — cả 2 OpenAI-compatible.
- API: `POST /api/transcribe_multi` (multipart: `file` + `asrs` JSON + `catalog` + `threshold` + `use_unidecode` + `normalize`).

## Kiến trúc
- **frontend/** — Vite + React + TS + Tailwind. UI cấu hình STT + audio (upload/mic) + hiển thị transcript thô vs đã chuẩn hoá + bảng thay thế.
- **backend/** — FastAPI. Proxy audio tới STT endpoint (OpenAI-compatible `/audio/transcriptions`) rồi chạy normalize (`rapidfuzz` + `unidecode`).

## Chạy

### 1. Backend (cổng 8077)
```bash
cd backend
.venv/Scripts/python.exe -m uvicorn app:app --port 8077 --reload
# (lần đầu: python -m venv .venv && .venv/Scripts/python.exe -m pip install -r requirements.txt)
```

### 2. Frontend (cổng 5180)
```bash
cd frontend
npm install      # lần đầu
npm run dev      # → http://localhost:5180
```
Vite proxy sẵn `/api` → `http://localhost:8077` (khỏi lo CORS).

## Dùng
1. **Cấu hình model STT** (cột trái): endpoint (vd `https://api.openai.com/v1` hoặc endpoint pop-multi/faster-whisper của bạn), model, ngôn ngữ, API key, prompt/hotwords (biasing).
2. **Hậu xử lý fuzzy**: dán catalog brand/SKU (mỗi dòng 1 mục), chỉnh ngưỡng, bật/tắt bỏ dấu (unidecode).
3. **Audio** (cột phải): upload file hoặc thu mic → **Transcribe + Chuẩn hoá**.
4. Xem **transcript thô** vs **sau chuẩn hoá** (cụm sửa được tô xanh) + **bảng thay thế** (STT nghe → sửa thành → điểm) + độ trễ.

## API
- `POST /api/transcribe` — multipart: `file` + form (`endpoint`, `api_key`, `model`, `language`, `prompt`, `catalog` (JSON array), `threshold`, `use_unidecode`, `normalize`) → `{raw, normalized, matches[], latency_ms}`.
- `POST /api/normalize` — test riêng fuzzy (không cần audio): `{text, catalog, threshold, use_unidecode}`.

## Ghi chú kỹ thuật
- Fuzzy: so theo `_key` = bỏ dấu (unidecode) + bỏ khoảng trắng → khớp được cả khi STT tách/gộp từ khác cách viết catalog (vd "sam súng"→"Samsung", "ét 24"→"S24"). Thử nhiều kích thước cửa sổ, chọn không chồng lấn theo điểm cao.
- Giới hạn đã biết: số đọc-chữ ("mười lăm" vs "15") chưa khớp — cần thêm number-normalization (vinorm/underthesea) nếu cần.

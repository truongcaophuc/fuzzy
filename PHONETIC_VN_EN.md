# Nhận diện brand tiếng Anh đọc "lơ lớ" — Phonetic VN→EN, Fuzzy & Alias

> Ghi chú phân tích cho STT Studio: vì sao một số brand tiếng Anh đọc giọng Việt không nhận ra được, và cơ chế xử lý (phonetic key VN→EN + fuzzy + alias + biasing).

---

## 1. Vấn đề
Người Việt đọc brand tiếng Anh theo giọng Việt → ASR (train chủ yếu tiếng Việt) **ghi lại bằng chính tả kiểu Việt**, lệch khỏi cách viết Anh:

| Brand | STT nghe ra | Khớp catalog? |
|---|---|---|
| Samsung | "sam súng" | ✅ (gần giống) |
| Walmart | "qua mát" / "oan mát" | ⚠️ cần phonetic |
| Porsche | "bọt che" / "bọt trơn" | ❌ cần alias |
| Goodyear | "good chia" / "gutia" | ❌ nghe sai âm tiết |
| FedEx | "phét ét" / "fad" | ❌ nghe thiếu |

Có **3 tầng** xử lý, mỗi tầng giải một loại lỗi:

| Tầng | Giải lỗi | Tác động ở đâu |
|---|---|---|
| **Biasing / Hotword** | nghe-sai-tại-nguồn | **trong STT** (đổi cả "Thô") |
| **Fuzzy + Phonetic key** | lệch nhẹ (sai dấu/âm w·f) | hậu xử lý (không đổi "Thô") |
| **Alias** | ca cá biệt lệch nặng | hậu xử lý (khớp chính xác) |

---

## 2. Phonetic VN→EN hoạt động thế nào

**Là "khoá so khớp ngầm" — KHÔNG đổi text hiển thị, KHÔNG đụng STT.** Chỉ dùng để TÍNH ĐIỂM fuzzy.

```
STT trả về raw ────────────────────────────►  hiển thị "THÔ" (nguyên bản 100%, KHÔNG phonetic)
      │
      ├─ (ngầm) "qua mát" → "wamat"   ← phonetic CHỈ dùng ở đây để so điểm
      │          so với "walmart" → 83đ ≥ ngưỡng → khớp
      ▼
   thay cụm khớp bằng TÊN CHUẨN catalog ──►  hiển thị "SAU CHUẨN HOÁ": ...Walmart
```

- **"Thô"** = output STT nguyên bản (không phonetic/fuzzy/alias).
- **Phonetic** chạy ngầm giữa "Thô" và catalog, lấy `max(điểm_gốc, điểm_phonetic)`.
- **"Sau chuẩn hoá"** = "Thô" + thay cụm khớp bằng **tên chuẩn** (không phải dạng "wamat").
- Dạng "wamat"/"wa mat" **không bao giờ hiển thị** — chỉ sống trong bộ nhớ lúc so khớp → **không phá tiếng Việt** (quả/quà/quận giữ nguyên).

> ⚠️ Khác **biasing/hotword**: cái đó tác động **lúc STT** và **đổi luôn "Thô"** (model nghe khác đi). Phonetic key là hậu xử lý, "Thô" không đổi.

---

## 3. Âm tiếng Anh → tiếng Việt: cái nào map được, cái nào không

Tiếng Việt thiếu phụ âm đầu **w / j / f / z** → ASR nắn theo quy luật. Nhưng **chỉ map ngược an toàn được** khi VN nắn về **chữ ĐẶC THÙ**; nếu nắn về **chữ phổ biến** thì map sẽ phá tiếng Việt.

| Âm Anh | VN nắn thành | Map ngược an toàn? | Ghi chú |
|---|---|:---:|---|
| **/w/** | `qu` (qua), `oa` (oan) | ✅ Có | qu/oa đặc thù → `qu→w`, `oa→wa` |
| **/f/** | `ph` (phét) | ✅ Có | `ph→f` |
| **/dʒ/** (j trong Johnson) | `gi` (giôn) | ✅ một phần | `gi→j` |
| **/z/** | `d`, `r`, `gi` | ❌ Không | d/r quá phổ biến → false positive |
| **/j/** (y trong "year") | `d`, `gi`, `ch`, `i` | ❌ Không | ch/d/i quá phổ biến |

**Bằng chứng vì sao /z/, /j/ không thêm được** (test ở ngưỡng 70, thêm `d→z`/`r→z`):
- Lợi: Amazon "a ma dôn" 83 → 100.
- **Hại: "đi ra" → Adidas 80đ** (sửa nhầm!), "dao động" → Amazon 62, "rồi đó" → Domino's 62.
→ Phá tiếng Việt nhiều hơn lợi → **giữ rule chỉ w/j(gi)/f**.

### Quy luật phonetic đang dùng (`_PHON_RULES`)
```
ph → f      (FedEx, Ford)
qu → w      (Walmart: qua → wa)
gi → j      (Johnson: giôn → jon)
oa → wa     (Walmart: oan → wan)
oe → we
```
> Lưu ý: "y" trong tiếng Anh có 2 kiểu — **nguyên âm** (happy = /i/ → "i", dễ) và **phụ âm /j/** (year, yes → d/gi/ch/i, KHÓ, không map được).

---

## 4. Bảng điểm thực tế (ngưỡng 70)

| Brand | STT nghe | base | +phonetic | Kết quả | Lý do |
|---|---|---:|---:|---|---|
| Samsung | sam súng | 100 | 100 | ✅ | gần giống |
| Walmart | qua mát | 62 | **83** | ✅ | qu→w cứu |
| Walmart | oan mát | 62 | **77** | ✅ | oa→wa cứu |
| Johnson | giôn sơn | 71 | **92** | ✅ | gi→j |
| FedEx | phét ét | 36 | 60 | ❌ | nghe thiếu đuôi "ex" |
| FedEx | fad | 50 | 50 | ❌ | quá ngắn, mất "edex" |
| Goodyear | good chia | 62 | 62 | ❌ | "year"→"chia" (/j/ không map) |
| Goodyear | gutia | 31 | 31 | ❌ | nghe sai cả từ |
| Walmart | qua mát | — | — | — | (xem trên) |
| Colgate | con god | 46 | 46 | ❌ | nghe sai cả âm tiết |
| Porsche | bọt che | 77 | 77 | ⚠️ | sát ngưỡng (alias chắc hơn) |

**Phân loại lỗi:**
- ✅ **Fuzzy/phonetic cứu được**: lệch nhẹ, hoặc lỗi w/f (Samsung, Walmart, Johnson).
- ❌ **Không cứu được bằng hậu xử lý**: STT **nghe sai cả âm tiết** (Goodyear "year"→"chia", Colgate "gate"→"god", FedEx→"fad"). Đây là lỗi **tại tầng STT**, không phải fuzzy.

---

## 5. Vì sao Goodyear / Colgate / FedEx fail (dù đã có phonetic)

> **Gốc rễ ở tầng ASR — nghe sai, KHÔNG phải lỗi fuzzy.**

- ASR Việt gặp **cụm âm lạ** (Good-**year**, Col-**gate**, Fed-**ex**) → "nắn" về cụm tiếng Việt quen, đôi khi thành **chuỗi có nghĩa**: "qua mặt", "con god", "khôn gết".
- Transcript **không còn chứa** chữ nào gần brand → từ đã **mất ngay ở bước nghe**.
- Hậu xử lý (fuzzy/phonetic/alias) chỉ vớt được khi lệch **nhỏ**; lệch nặng (30–60đ) thì bó tay.
- ROVER cũng vô dụng vì **cả 2 ASR đều nghe sai**, mỗi con sai một kiểu → không có "bản đúng" để bỏ phiếu.

---

## 6. Chiến lược xử lý (chọn đúng công cụ)

| Tình huống | Dùng |
|---|---|
| Lệch nhẹ (sai dấu/âm), lỗi **w / f** | **Phonetic key + fuzzy** (tự động) |
| Brand cá biệt, lỗi **z / j(yod)**, hoặc nghe-sai-hẳn | **Alias** (`cách đọc => tên chuẩn`) |
| Muốn sửa **tận gốc** (model nghe đúng) | **Biasing / Hotword** ở STT |

### ⚠️ Đừng làm
- **Đừng hạ ngưỡng < 70** để "ép" fuzzy → kéo theo false positive (vd "đi ra"→Adidas, từ 3 ký tự ngẫu nhiên ~50% với brand bất kỳ).
- **Đừng thêm rule** `d→z`, `r→z`, `ch→y`, `i→y` → phá tiếng Việt (d/r/ch/i quá phổ biến).

### Ví dụ alias cho mấy ca khó
```
# /z/, /j/, nghe-sai-hẳn → alias
bọt che => Porsche
bọt trơn => Porsche
good chia => Goodyear
gutia => Goodyear
con god => Colgate
fad => FedEx
qua mặt => Walmart        # (hoặc để phonetic lo "qua mát")
```
> Alias an toàn vì khớp **chính xác** chuỗi đã khai báo, không phụ thuộc ngưỡng.

---

## 7. Tóm tắt 1 phút
1. **Phonetic VN→EN** = khoá so khớp ngầm (w→qu/oa, f→ph, j→gi). Không đổi "Thô", không phá tiếng Việt. Cứu được Walmart/Johnson.
2. **/z/ và /j/(year)** không map được vì VN nắn về chữ phổ biến (d/r/ch/gi/i) → false positive.
3. **Goodyear/Colgate/FedEx** fail vì **ASR nghe sai cả âm tiết** (lỗi tại nguồn) → fuzzy/phonetic bất lực → phải **alias** hoặc **biasing**.
4. Thứ tự nên dùng: **Biasing (nguồn) → Phonetic+Fuzzy (lệch nhẹ) → Alias (cá biệt)**. Không hạ ngưỡng, không thêm rule cho chữ phổ biến.

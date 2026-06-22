
> Hậu xử lý STT: sửa tên brand/SKU bị nghe lệch, mà KHÔNG phá tiếng Việt ,chạy ngay sau STT trong pipeline voice.

---

## 🟢 Đọc nhanh

*(Bản rút gọn không thuật ngữ. Chi tiết kỹ thuật ở các mục 1–9 bên dưới.)*

**Bài toán:** người Việt đọc tên hãng tiếng Anh "lơ lớ" → máy nghe-chép ghi theo kiểu Việt (Samsung→"sam súng", Walmart→"qua mát"). Cần  **sửa lại tên hãng chuẩn mà KHÔNG đụng tiếng Việt thật** .

| Mục                              | Nói đơn giản                                                                                                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Chuẩn hoá chữ**     | Làm sạch cả 2 chuỗi: bỏ dấu, viết thường,**bỏ luôn space**("sam súng"→`samsung`) để khớp dù máy tách/dính từ tuỳ hứng. Thêm luật "ph=f, qu=w..." vì tiếng Việt thiếu mấy âm này.                                                          |
| **2. Chấm điểm**         | Đếm ký tự trùng → ra điểm 0–100. Giống y = 100. Chuỗi ngắn dễ ăn điểm ảo → cần chặn.                                                                                                                                                                          |
| **3. Cuốn từ điển**     | Có list ~8.800 âm tiết Việt thật. Cụm**không có trong list**= nghi tên hãng →**dễ dãi hơn**(xem giải thích "nới lỏng" ngay dưới). Từ Việt thật thì vẫn khó tính → không phá.                                                            |
| **4. Cỗ máy sửa chính** | Trượt "cửa sổ" vài từ dọc câu, so với từng tên hãng. Có 3 lớp chặn (biên là từ đệm / khác âm đầu / quá ngắn). Đủ điểm (≥75) thì sửa. Cụm rất ngắn (Fox/KFC) phải khít ≥90 mới dám sửa.                                                  |
| **5. Liệt kê ứng viên** | Giống mục 4 nhưng**không tự sửa** , chỉ liệt kê hãng khả nghi để đưa cho AI. Cụm ngắn vẫn lọt vào danh sách (từ 50đ) nhưng chưa được sửa.                                                                                                      |
| **6. ROVER**                | Chạy nhiều máy nghe cùng lúc → bỏ phiếu từng từ chọn bản tốt nhất.                                                                                                                                                                                                  |
| **7. Tự quyết**           | <50 = bỏ qua; 50–75 = chưa chắc, hỏi AI; ≥75 + bỏ xa hãng nhì = tự chốt.                                                                                                                                                                                               |
| **7b. Nhờ AI phân xử**   | Ca khó (đồng âm) thì hỏi AI: "phở" là món hay hãng Fox? AI trả tên hãng hoặc "không có".**smart**= chỉ hỏi ca lưng chừng (nhanh, lọt ca điểm cao sai);**verify**= hỏi cả ca điểm cao (chậm hơn nhưng bắt được "qua mặt"≠Walmart). |
| **8. Giới hạn**           | Fuzzy chỉ nhìn mặt chữ → trần ~40–50%. Đồng âm chỉ AI tách được. Đừng hạ ngưỡng <70 kẻo vỡ tiếng Việt.                                                                                                                                                    |

**Tóm 1 câu:** *Làm sạch chữ → chấm điểm giống → chặn mấy cái dễ nhầm → đủ chắc thì tự sửa, lưng chừng thì hỏi AI, đồng âm thì để AI phân xử.*

---

## 0. Vấn đề

Người Việt đọc brand tiếng Anh "lơ lớ" → STT (train tiếng Việt) ghi bằng chính tả Việt, lệch khỏi tên Anh: `Samsung → "sam súng"`, `Walmart → "qua mát"`, `S24 → "ét 24"`. Cần khớp lại về tên chuẩn trong catalog.

---

## 1. Khoá so khớp (matching keys)

Mỗi chuỗi được biến thành **khoá** trước khi so:

```
_norm(s)      = lower(s) + unidecode(s)          # bỏ dấu + thường:  "Sàm Súng" → "sam sung"
_key(s)       = "".join(_norm(s).split())        # + BỎ HẾT space:    "ét 24" → "et24"
_phon_key(s)  = _key sau khi áp _PHON_RULES       # back-transliterate Việt→Anh
```

**Vì sao bỏ space:** STT cắt/gộp từ tùy hứng ("ét 24" vs "S24", "sam súng" vs "Samsung"). Bỏ space → khớp được bất kể cách cắt.

### Luật phiên âm ngược `_PHON_RULES`

Tiếng Việt thiếu phụ âm đầu **/f/ /w/ /dʒ/** → ASR nắn theo cách viết Việt. Đảo ngược để khớp:

```
ph → f      (FedEx "phét"→"fét", Ford "pho"→"fo")
qu → w      (Walmart "qua mát"→"wa mát")
oa → wa     (Walmart "oan mát"→"wan mát")
oe → we
gi → j      (Johnson "giôn"→"jôn")
```

* Áp cho **MỌI** cụm (broad), chỉ để  **TÍNH ĐIỂM** , không đổi text hiển thị.
* **KHÔNG có /z/ và /j/(year)** vì Việt nắn về chữ phổ biến (d/r/ch/i) → false positive ("đi ra"→Adidas).
* Điểm = `max(điểm_so_thẳng, điểm_so_qua_phon)` → chỉ cộng thêm, không phá ca đã đúng.

---

## 2. Điểm tương đồng — `fuzz.ratio` (rapidfuzz)

```
fuzz.ratio(a, b) = 2 × (ký tự khớp) / (len(a) + len(b)) × 100      # 0–100, dựa Levenshtein/Indel
```

* Càng giống càng cao. `"samsung" vs "samsung" = 100`.
* **Lưu ý chuỗi ngắn** : 1–2 ký tự trùng đã cho điểm cao giả ("fo" vs "fox" = 80) → cần guard (mục 4).

---

## 3. Gate "ngoại lai" bằng TỪ ĐIỂN âm tiết

File `backend/vn_syllables.txt` (~8.784 âm tiết Việt CÓ THẬT,  **giữ dấu** , rút từ Viet74K).

```
_is_vn_syllable(tok) = tok.lower() ∈ _VN_SYLLABLES      # tra GIỮ DẤU
_window_is_foreign(window) = có ≥1 token KHÔNG trong từ điển
```

* Phải **giữ dấu** mới phân biệt "địa"(thật) với "dia"(year nghe nhầm, không có thật).
* Dùng để **hạ ngưỡng CÓ CHỌN LỌC** cho cụm ngoại lai (mục 4) — không phá tiếng Việt vì âm tiết thật giữ ngưỡng gốc.

### "Nới lỏng" nghĩa là gì?

Bình thường cụm phải đạt **≥ threshold (75)** mới được khớp/sửa. Tuỳ cụm là Việt-thật hay lạ:

```
cụm CÓ trong từ điển (vd "địa","qua","đi")  → giữ bar 75            (khó sửa → bảo vệ tiếng Việt)
cụm KHÔNG có trong từ điển (vd "in tồ","gút") → hạ bar = max(58, 75−15) = 60   (dễ khớp hơn)
        (hằng số: _FOREIGN_DELTA=15 hạ bao nhiêu, _FOREIGN_FLOOR=58 sàn tối thiểu)
```

| Cụm     | Việt thật?  | Bar                | Điểm vs hãng | Kết quả                                   |
| -------- | ------------- | ------------------ | --------------- | ------------------------------------------- |
| "in tồ" | ❌ không có | **60**(nới) | Intel 66.7      | ≥60 → khớp được                       |
| "đi ra" | ✅ có        | **75**(giữ) | Adidas ~62      | 62 < 75 →**KHÔNG**đụng (bảo vệ) |

→ Ý tưởng:  **chỉ dễ dãi với cụm "nghe đã thấy Tây Tây"** , từ Việt thật vẫn khó tính → không phá nghĩa. → Lưu ý: nới lỏng giúp `normalize_text` *bắt được* (eff thấp), nhưng **gating vẫn cần ≥75 mới tự chốt** — nên "in tồ"→Intel 66.7 chỉ thành  **ứng viên chờ LLM** , chưa tự sửa.

---

## 4. `normalize_text` — thuật toán chính (fuzzy tự-thay)

```
Input: text, catalog[], threshold=75, aliases{}, use_phonetic=True

① pairs = [(brand, brand, is_alias=False) for brand in catalog]
         + [(cách_đọc, tên_chuẩn, is_alias=True) for alias in aliases]

② Với mỗi pair (target, replacement, is_alias):
     target_key, target_phon
     trượt cửa sổ k = 1 … min(n, số_từ_target + 2),  vị trí i khắp câu:
       window = các từ [i : i+k]

       GUARD `_window_blocked` (CHỈ cho catalog, KHÔNG cho alias) — bỏ window nếu:
         • biên là stopword (về/cho/tôi/nha/hỏi/đi/...)   [_is_stop]
         • khác NHÓM ÂM ĐẦU với brand                      [_same_sound — xem mục 5③]
         • quá ngắn tương đối: len(window_key) < 0.6 × len(target_key)
       → ĐÂY LÀ BỘ LỌC DÙNG CHUNG với get_candidates (2 đường giờ đồng bộ).

       score  = fuzz.ratio(_key(window), target_key)
       nếu phonetic: score = max(score, fuzz.ratio(_phon_key(window), target_phon))

       NGƯỠNG eff:
         • alias  → eff = 88 (_ALIAS_THRESHOLD)   ← khớp gần tuyệt đối, chống leak
         • catalog→ eff = threshold (75)
              nếu cụm NGOẠI LAI (gate)  thì eff = max(58, threshold − 15)   ← hạ ngưỡng cho ngoại lai

       GUARD SPAN NGẮN (catalog): nếu len(window_key) < 4 ký tự → CHỈ tự-thay khi score ≥ 90
              (bắt brand ngắn lúc STT ghi khít "tôi muốn Fox"→Fox 100;
               chặn đồng âm "phở"→Fox 80 và rác "hát"→Honda 50)

       nếu score ≥ eff → thêm candidate Match(window, replacement, score, i, k)

③ Chọn THAM LAM không chồng lấn:
     sort candidates theo (điểm giảm dần, độ dài giảm dần)
     duyệt: nhận nếu span chưa bị span khác chiếm

④ Thay thế: từ phải sang trái (giữ chỉ số), span → replacement
   → trả {normalized, matches}
```

### 4 lớp bảo vệ gắn trong thuật toán

| Lớp                                                                      | Mục đích                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Phonetic key**                                                    | bắt brand âm w/f/j (Walmart, Johnson, FedEx)                                                               |
| **Dict-gate + hạ ngưỡng có chọn lọc**                         | nới cho ngoại lai mà giữ tiếng Việt ở ngưỡng gốc                                                   |
| **Guard độ dài**(≥60% target; span <4 ký tự cần điểm ≥90) | chống token ngắn match nhầm ("dia"→Adidas, "sờ"→Sony); brand ngắn vẫn bắt được khi STT ghi khít |
| **Alias ngưỡng 88**                                               | ca nghe-sai-ổn-định khai tay, không leak vào từ Việt phổ biến                                       |

---

## 5. `get_candidates` — sinh ứng viên (mớm LLM)

Cùng cơ chế trượt cửa sổ + `fuzz.ratio`, nhưng **lọc CHẶT hơn** để ra danh sách "đáng ngờ là brand":

```
① Guard độ dài: ≥ 0.6 × len(brand_key)  (span <4 ký tự VẪN vào ứng viên ở floor 50 → để LLM chọn;
     riêng việc AUTO-COMMIT span ngắn mới cần ≥90 — xem mục 7)
② Lọc BIÊN từ-đệm: bỏ window bắt đầu/kết thúc bằng stopword (về/cho/tôi/nha/hỏi/đi/...)
③ Lọc NHÓM ÂM ĐẦU: first_sound(window) phải khớp first_sound(brand)
      /s/ ← s,x,c(mềm trước e/i/y) ;  /f/ ← f,ph ;  /w/ ← w,qu ;  /dʒ/ ← j,gi ;  /k/ ← k,c(cứng trước a/o/u),q
      /ch/ ← c+h  → NHÓM RIÊNG (chợ/cha/chú KHÔNG lẫn /h/ Honda; Chevrolet đọc "chê" cũng /ch/)
      nguyên âm → "V" ;  còn mơ hồ (d/z) → "?" → KHÔNG prune (giữ an toàn)
④ floor: chỉ giữ điểm ≥ 50 ; dedupe theo brand (giữ điểm cao nhất) ; lấy top-k
```

→ **Đã ĐỒNG BỘ:** cả `normalize_text` (catalog) lẫn `get_candidates` đều dùng chung `_window_blocked` (biên-stopword + nhóm-âm-đầu + ≥0.6×len). Khác biệt DUY NHẤT còn lại là  **xử lý span ngắn (<4 ký tự)** :

* `normalize_text` (đường TỰ-THAY): span ngắn cần **≥90** mới thay → an toàn, không tự đổi nghĩa.
* `get_candidates` (đường ỨNG VIÊN): span ngắn vào danh sách từ **≥50** để LLM thấy; nhưng gating chỉ cho AUTO khi ≥90 (mục 7). → Nhờ vậy "ăn  **phở** " có ứng viên Fox 80 (cho LLM) nhưng KHÔNG bị tự-thay.

---

## 6. ROVER — gộp nhiều ASR

`rover.py`: căn từng từ giữa các bản (đã chuẩn hoá), bỏ phiếu theo trọng số = `1 + Σ(điểm khớp brand)/1000`. Hệ có nhiều brand/SKU khớp = đáng tin hơn → phá hoà phiếu. (Mạnh khi ≥3 ASR; 2 ASR chỉ phá hoà.)

---

## 7. Gating: khi nào tin fuzzy / khi nào cần LLM

Dựa trên ứng viên (`_decide_llm`):

```
eff_high = AUTO_HIGH (= ngưỡng fuzzy của request)
       NẾU span của ứng viên top < 4 ký tự  →  eff_high = max(AUTO_HIGH, 90)   ← brand ngắn chỉ auto khi gần-khít

top < 50 (floor)                        → SKIP  (không brand)
50 ≤ top < eff_high                     → LLM   (chưa chắc → mớm top-k cho LLM quyết)
top ≥ eff_high  VÀ  cách biệt #2 ≥ 12   → AUTO  (tin fuzzy, chốt luôn)
```

* `AUTO_HIGH` = ngưỡng fuzzy của request (slider, hiện 75 — fuzzy & gating DÙNG CHUNG), `_LLM_FLOOR=50`, margin 12.
* **Span ngắn (<4 ký tự, brand Fox/KFC/DHL):** vẫn là ỨNG VIÊN từ 50 (LLM thấy), nhưng  **chỉ AUTO khi ≥90** . → "tôi muốn  **Fox** " (100) → AUTO; "ăn  **phở** " (Fox 80) → ỨNG VIÊN cho LLM, KHÔNG commit (đồng âm).

---

## 7b. LLM Arbiter — phân định đồng âm theo NGỮ CẢNH

Fuzzy chỉ nhìn hình thức chuỗi → không phân biệt "phở (món)" vs "Fox (hãng)". Tầng LLM giải quyết phần đuôi.

### Hợp đồng (prompt)

Gửi LLM **CHỈ câu + danh sách ứng viên brand** (không gửi cả catalog) → LLM trả  **JSON thuần** :

```
system: "Chọn TÊN BRAND đúng từ ứng viên, hoặc null nếu câu chỉ là tiếng Việt thường (đồng âm)."
        + vài ví dụ few-shot (ăn phở→null, tôi muốn Fox→Fox, qua mặt→null, cốc cô ca→Coca-Cola)
user:   'câu: "<text>"\nứng viên: ["Walmart", ...]'
→ {"brand": "Walmart"}  hoặc  {"brand": null}
```

* Parse chịu được bọc ````json `(strip fence + regex`\{...\}`).
* `pick` phải thuộc danh sách ứng viên (validate, khớp không phân biệt hoa/thường), nếu không → bỏ.
* **Áp:** thay đúng cụm `span` của brand được chọn vào câu (1 lần). `null` → giữ nguyên câu.
* **Lỗi LLM** (timeout/parse) → fallback giữ kết quả gating thuần (không bao giờ chặn pipeline).

### 2 chế độ (mode)

| Mode             | Hỏi LLM khi                                        | Đánh đổi                                                                            |
| ---------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **smart**  | CHỈ ca `llm`(50 ≤ top < eff_high)               | nhanh; ca `auto`chốt thẳng**KHÔNG**hỏi → đồng âm điểm cao LỌT        |
| **verify** | CẢ ca `auto`lẫn `llm`(mọi ca có ứng viên) | chậm hơn (~0.5s/ca có ứng viên) nhưng**bắt được đồng âm điểm cao** |

→ **Điểm mấu chốt:** false-positive nguy hiểm nhất "qua mặt"→Walmart ở **83đ = vùng AUTO** → **chỉ verify** mới chặn được (smart bỏ qua). Verify: gating=auto NHƯNG LLM trả null →  **revert về câu gốc** .

### LLM dùng cái gì

* **stt-studio:** khai base_url/model/key riêng trong tab Cài đặt (OpenAI-compatible).
* **perfox-aw-repa:** **tái dùng **`<strong>engine.inference_llm</strong>` của workflow (không config riêng) qua `run_inference(ctx, system_instruction=...)`.
* Model đang dùng: **gemma-4-26B-A4B-it-AWQ-4bit** (popthink/LiteLLM), p50 ~0.5s, đủ nhanh vì chỉ chạy khi có ứng viên.

---

## 7c. Test case tiêu biểu (ngưỡng 75, phonetic ON)

Mỗi câu minh hoạ MỘT cơ chế. (Bộ đầy đủ 50 câu bẫy: `FALSE_POSITIVE_RESULT.md`.)

| #  | Câu (STT thô)                   | Fuzzy top      | Gating | Cuối — smart | Cuối — verify (LLM) | Minh hoạ                                              |
| -- | --------------------------------- | -------------- | ------ | -------------- | --------------------- | ------------------------------------------------------ |
| 1  | đặt giúp tôi cốc cô ca      | Coca-Cola 75   | auto   | → Coca-Cola   | → Coca-Cola          | auto rõ, LLM xác nhận                               |
| 2  | tôi qua mặt được nó rồi    | Walmart 83.3   | auto   | → Walmart ❌  | giữ "qua mặt" ✅    | đồng âm VÙNG AUTO: chỉ verify cứu                |
| 3  | tôi muốn mua Walmart gần đây | Walmart 100    | auto   | giữ Walmart   | giữ Walmart          | brand thật điểm cao — cả 2 đúng                 |
| 4  | tôi muốn  Fox                   | Fox 100        | auto   | giữ Fox       | giữ Fox              | span ngắn KHÍT ≥90 → nhận                         |
| 5  | sáng nay ăn phở bò            | Fox 80         | llm    | giữ "phở"    | giữ "phở"           | span ngắn ĐỒNG ÂM: ứng viên nhưng KHÔNG commit |
| 6  | nhà mình sâm sung lắm         | Samsung 100    | auto   | → Samsung     | → Samsung            | phonetic (sam sung≈samsung) + đủ dài               |
| 7  | cái nồi in tồ tì rồi         | Intel 66.7     | llm    | giữ           | giữ (LLM null)       | ngoại lai điểm vừa → chờ LLM                     |
| 8  | xích cô chó lại kẻo chạy    | Coca-Cola 70.6 | llm    | giữ           | giữ                  | borderline 70.6 < 75 → KHÔNG auto                    |
| 9  | đi chợ mua mớ rau              | —             | skip   | giữ           | giữ                  | "chợ" âm-đầu /ch/ ≠ Honda /h/ → không lọt      |
| 10 | gặp lại bạn cũ vui ghê       | Visa 57.1      | llm    | giữ           | giữ (LLM null)       | control: ứng viên rác bị LLM bác                  |

→ Cột **smart vs verify** chỉ khác ở **dòng 2** (đồng âm điểm cao) — đó là lý do tồn tại mode verify.

---

## 8. Giới hạn đã biết (rất quan trọng)

* **fuzzy = bottom-up** (chỉ hình thức chuỗi). Trần ~40–50% brand; phần đuôi **LLM-arbiter (mục 7b)** gánh.
* **Đồng âm** : brand-đọc-giọng-Việt **trùng** cụm Việt thật → KHÔNG ngưỡng/chính tả nào tách được: `qua mát ↔ "qua mặt"`, `sấp quây ↔ "sắp quay"`, `phở ↔ Fox`. → fuzzy chỉ ĐỀ XUẤT, **LLM-arbiter mode verify** (hoặc biasing STT) mới phân định.
* **Brand ngắn (≤4 ký tự, Fox/KFC/DHL)** : fuzzy chỉ tự-thay khi STT ghi  **khít ≥90** ; ca lơ-lớ (nai→Nike ~57) thì **dùng alias** (ngưỡng 88).
* **Đừng hạ ngưỡng toàn cục < 70** : phá tiếng Việt (xem `FALSE_POSITIVE_TEST.md` — 14/50 câu Việt bị nhầm ngay ở 70). Hiện mặc định  **75** .
* **Funnel thực nghiệm (bộ bẫy 50 câu):** 14/50 sai (không guard) → 5/50 (guard) → 1/50 (gating @75) → **0 phá nghĩa khi bật LLM verify** (LLM bác nốt "qua mặt"→Walmart). Xem `FALSE_POSITIVE_RESULT.md`.

---

## 9. Tóm tắt luồng đầy đủ

```
STT thô
  → normalize_text (tự-thay alias luôn; catalog: _window_blocked + eff + span<4 cần ≥90)   [đường commit]
  → get_candidates (cùng _window_blocked; span<4 vào từ 50; floor 50; top-k)                [đường ứng viên]
  → _decide_llm(candidates, auto_high=threshold)  → skip / auto / llm   (span<4 ⇒ auto cần ≥90; margin #2 ≥12)
  → LLM arbiter (nếu bật): smart=chỉ ca llm | verify=cả ca auto  → pick brand | null
  → CÂU CUỐI:  auto→tên chuẩn | llm+pick→thay theo LLM | llm+null/skip→giữ nguyên
  (nhiều ASR: ROVER gộp trước khi quyết)
```

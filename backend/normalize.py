"""Post-ASR normalization: sửa tên brand/SKU bằng fuzzy matching (rapidfuzz + unidecode).

Ý tưởng: trượt cửa sổ k-từ trên transcript, so (đã bỏ dấu) với từng mục catalog;
nếu điểm >= ngưỡng thì thay bằng tên chuẩn. Chọn không chồng lấn, ưu tiên điểm cao.
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from rapidfuzz import fuzz
from unidecode import unidecode


def _norm(s: str, use_unidecode: bool = True) -> str:
    s = s.lower().strip()
    return unidecode(s) if use_unidecode else s


def _key(s: str, use_unidecode: bool) -> str:
    """Chuẩn hoá để so khớp: bỏ dấu + thường + BỎ khoảng trắng — nhờ đó khớp được cả khi
    STT tách/gộp từ khác cách viết catalog (vd 'ét 24' ~ 'S24', 'sam súng' ~ 'Samsung')."""
    return "".join(_norm(s, use_unidecode).split())


# Quy luật back-transliterate VN->EN: tiếng Việt thiếu phụ âm đầu w/j/f/z nên ASR Việt
# nắn brand tiếng Anh theo các cách viết dưới. Đảo ngược để fuzzy khớp lại.
# vd: Walmart -> "qua mát"/"oan mát" -> "wamat"/"wanmat" ~ "walmart".
# "z" -> "j": tiếng Việt KHÔNG có chữ "z" và không phân biệt /dʒ/(J) với /z/(Z) —
# cả hai đều đọc bằng gi/d. Gom "z" về cùng nhóm "j" để "Zara" (key 'jara') khớp cách
# đọc Việt "gia ra"/"da ra" (cũng -> 'jara'). An toàn: chỉ ảnh hưởng từ ngoại/brand.
_PHON_RULES = [("ph", "f"), ("qu", "w"), ("gi", "j"), ("z", "j"), ("oa", "wa"), ("oe", "we")]

# Phụ âm ĐẦU TỪ -> nhóm âm chuẩn (chỉ ở đầu từ để không phá tiếng Việt):
#  - /dʒ/ (J tiếng Anh): "gi" (đã ở _PHON_RULES), "ch", "d/đ" -> "j"
#    (Jollibee nghe "chô li bi"/"dô li bi"/"giô li bi").
#  - /p/ (P tiếng Anh): người Việt đọc thành "b" (Pepsi->"bép si", Pizza->"bi za") và hầu
#    như KHÔNG có từ Việt bắt đầu bằng "p" (p tiếng Việt nằm ở CUỐI: họp/đẹp/lớp) -> p->b.
_INITIAL_RULES = (("ch", "j"), ("d", "j"), ("p", "b"))


def _phon_key(s: str) -> str:
    """Khoá so khớp PHỤ (phonetic VN->EN). Chỉ dùng để TÍNH ĐIỂM, không đổi text hiển thị."""
    t = unidecode(s).lower()
    for a, b in _PHON_RULES:
        t = t.replace(a, b)
    toks = []
    for tok in t.split():
        for pre, rep in _INITIAL_RULES:
            if tok.startswith(pre):
                tok = rep + tok[len(pre):]
                break
        toks.append(tok)
    return "".join(toks)


# --- Gate "ngoại lai": token KHÔNG phải âm tiết tiếng Việt CÓ THẬT → nhiều khả năng là từ
# nước ngoài bị nghe lệch → cho phép nới ngưỡng (không phá tiếng Việt vì âm tiết thật giữ nguyên).
#
# Cách phát hiện: tra TỪ ĐIỂN ÂM TIẾT (giữ nguyên dấu) — chính xác hơn luật âm-vị-học cũ.
#   vd "địa"/"chia"/"gút" ∈ từ điển -> tiếng Việt thật (giữ); "dia"/"good"/"gết" ∉ -> ngoại lai.
# Phải GIỮ DẤU mới phân biệt được "địa"(có thật) với "dia"(year nghe nhầm, không có thật).
import os

_FOREIGN_DELTA = 15   # nới ngưỡng bao nhiêu điểm cho cụm ngoại lai
_FOREIGN_FLOOR = 58   # sàn tối thiểu để tránh match rác
_ALIAS_THRESHOLD = 88  # alias là chuỗi khai báo chính xác -> ngưỡng CAO (gần tuyệt đối),
                       # tránh leak: alias "gusia" KHÔNG được dính "già/gửi/gia" (~75đ)

# Fallback (nếu thiếu file từ điển): luật âm-vị-học cũ.
_BAD_INIT = ("f", "j", "w", "z")
_VN_FINALS = ("ch", "ng", "nh", "c", "m", "n", "p", "t")
_VOWELS = set("aeiouy")


def _load_syllables() -> set[str]:
    path = os.path.join(os.path.dirname(__file__), "vn_syllables.txt")
    try:
        with open(path, encoding="utf-8") as f:
            return {ln.strip().lower() for ln in f if ln.strip()}
    except OSError:
        return set()


_VN_SYLLABLES = _load_syllables()


def _is_vn_syllable(tok: str) -> bool:
    t = tok.lower().strip(".,!?;:\"'()[]")
    if not t:
        return True
    if _VN_SYLLABLES:                       # có từ điển -> tra trực tiếp (giữ dấu)
        return t in _VN_SYLLABLES
    # fallback âm-vị-học (khi thiếu file từ điển)
    u = unidecode(t)
    if u and u[0] in _BAD_INIT:
        return False
    if u and u[-1] not in _VOWELS and not any(u.endswith(c) for c in _VN_FINALS):
        return False
    return True


def _window_is_foreign(window: str) -> bool:
    """Cụm có chứa ÍT NHẤT 1 token không-phải-âm-tiết-tiếng-Việt → coi là ngoại lai."""
    return any(not _is_vn_syllable(t) for t in window.split())


# Từ đệm/chức năng tiếng Việt — brand KHÔNG bao giờ bắt đầu/kết thúc bằng mấy từ này.
# Bỏ window có biên là từ đệm để khỏi sinh ứng viên rác (vd "về sờ ta"→Visa).
# LƯU Ý: không đưa âm tiết hay xuất hiện trong phiên âm brand (qua/mát/ta/sờ/nét...) vào đây.
_STOPWORDS = {
    "cho", "tôi", "hỏi", "về", "nha", "nhé", "ạ", "với", "của", "là", "và", "này", "đó", "đấy",
    "giúp", "giùm", "dùm", "ơi", "được", "không", "muốn", "cần", "rồi", "thì", "mà", "ấy",
    "bạn", "anh", "em", "chị", "ông", "bà", "một", "các", "cái", "ở", "đi", "vào", "lên",
    "xuống", "đây", "kia", "nó", "họ", "mình", "ừ", "à", "nhỉ", "ha", "đã", "sẽ", "đang",
}


def _is_stop(tok: str) -> bool:
    return tok.lower().strip(".,!?;:\"'()") in _STOPWORDS


def _first_sound(s: str) -> str:
    """Nhóm âm đầu (đã qua phon ph→f/qu→w/gi→j). '?' = mơ hồ → KHÔNG prune."""
    k = _phon_key(s)
    if not k:
        return "?"
    c = k[0]
    if c in "aeiouy":
        return "V"          # nguyên âm
    if c in "fwj":
        return c            # /f/ /w/ /dʒ/ (từ ph/qu/gi)
    if c in "sx":
        return "s"          # /s/
    if c == "c":
        nxt = k[1] if len(k) > 1 else ""
        if nxt == "h":
            return "ch"     # "ch" → nhóm RIÊNG (chợ/cha/chú... không lẫn /h/ /s/ /k/; Chevrolet đọc "chê" cũng "ch")
        if nxt in "eiy":
            return "s"      # c mềm (Cisco)
        if nxt in "aou":
            return "k"      # c cứng (Coca)
        return "?"          # c + phụ âm khác → mơ hồ
    if c in "kq":
        return "k"
    if c in "dz":
        return "?"          # d/z nhập nhằng → giữ
    return c                # b m n p t l r h g v ... mỗi cái 1 nhóm


def _same_sound(w: str, brand: str) -> bool:
    fw, fb = _first_sound(w), _first_sound(brand)
    if fw == "?" or fb == "?":
        return True         # mơ hồ → giữ (không prune nhầm)
    return fw == fb


# Span NGẮN (<4 ký tự) chỉ nhận khi khớp GẦN-KHÍT (≥90) — để bắt brand ngắn lúc STT ghi đúng
# (Fox/KFC/DHL/IBM "tôi muốn Fox"→Fox 100) mà KHÔNG nhận đồng âm (phở→Fox 80) hay rác (hát→Honda 50).
# Áp ở chỗ tính điểm (cần score), không ở _window_blocked (chạy trước khi có score).
_SHORT_SPAN_MAXLEN = 4
_SHORT_SPAN_MIN = 90.0


# Guard chung (dùng cho cả get_candidates và normalize_text catalog) — bỏ window:
#  (a) biên là từ đệm, (b) khác nhóm âm đầu brand, (c) quá ngắn TƯƠNG ĐỐI so với brand.
# (KHÔNG còn chặn cứng <4 ký tự ở đây — thay bằng gate điểm ≥90 cho span ngắn ở chỗ chấm điểm.)
def _window_blocked(seg: list[str], window_key: str, brand: str, brand_key: str) -> bool:
    if _is_stop(seg[0]) or _is_stop(seg[-1]):
        return True
    if not _same_sound(" ".join(seg), brand):
        return True
    if len(window_key) < 2 or len(window_key) < 0.6 * len(brand_key):
        return True
    return False


def _short_span_blocked(window_key: str, score: float) -> bool:
    """Span ngắn (<4 ký tự) chỉ qua khi điểm ≥90 (gần-khít)."""
    return len(window_key) < _SHORT_SPAN_MAXLEN and score < _SHORT_SPAN_MIN


def get_candidates(text: str, catalog: list[str], top_k: int = 3, floor: float = 50.0,
                   use_unidecode: bool = True, use_phonetic: bool = True) -> list[dict]:
    """Sinh ỨNG VIÊN brand cho text (để mớm LLM). Lọc cửa-sổ-con-ngắn + biên-từ-đệm + dedupe theo brand.
    Trả [{brand, span, score}] top_k theo điểm giảm dần (chỉ giữ ≥ floor)."""
    if not text or not catalog:
        return []
    words = text.split()
    n = len(words)
    best: dict[str, tuple[float, str]] = {}
    for c in catalog:
        c = (c or "").strip()
        if not c:
            continue
        ck = _key(c, use_unidecode)
        if not ck:
            continue
        cp = _phon_key(c) if use_phonetic else None
        max_k = min(n, len(c.split()) + 2)
        for k in range(1, max_k + 1):
            for i in range(0, n - k + 1):
                seg = words[i:i + k]
                w = " ".join(seg)
                wk = _key(w, use_unidecode)
                if _window_blocked(seg, wk, c, ck):
                    continue
                s = fuzz.ratio(wk, ck)
                if use_phonetic:
                    s = max(s, fuzz.ratio(_phon_key(w), cp))
                # span ngắn (<4) VẪN vào danh sách ứng viên ở floor 50 (để LLM tự chọn);
                # việc auto-commit hay không do gating quyết (span ngắn cần ≥90 mới auto).
                if s > best.get(c, (0.0, ""))[0]:
                    best[c] = (s, w)
    ranked = sorted(((s, w, c) for c, (s, w) in best.items() if s >= floor), reverse=True)
    return [{"brand": c, "span": w, "score": round(s, 1)} for s, w, c in ranked[:top_k]]


def best_match_score(text: str, target: str, use_unidecode: bool = True, use_phonetic: bool = True) -> float:
    """Điểm fuzzy CAO NHẤT giữa `target` và mọi cửa sổ con của `text` (KHÔNG áp ngưỡng).
    Dùng để HIỂN THỊ độ gần — kể cả khi không đủ điểm để khớp."""
    if not text or not target:
        return 0.0
    words = text.split()
    n = len(words)
    tk = _key(target, use_unidecode)
    if not n or not tk:
        return 0.0
    tp = _phon_key(target) if use_phonetic else None
    max_k = min(n, len(target.split()) + 2)
    best = 0.0
    for k in range(1, max_k + 1):
        for i in range(0, n - k + 1):
            win = " ".join(words[i:i + k])
            s = fuzz.ratio(_key(win, use_unidecode), tk)
            if use_phonetic:
                s = max(s, fuzz.ratio(_phon_key(win), tp))
            if s > best:
                best = s
    return round(best, 1)


@dataclass
class Match:
    original: str      # cụm gốc trong transcript
    replaced: str      # tên chuẩn thay vào
    score: float       # điểm fuzzy 0-100
    start: int         # vị trí từ bắt đầu
    length: int        # số từ


def normalize_text(
    text: str,
    catalog: list[str],
    threshold: float = 80.0,
    use_unidecode: bool = True,
    aliases: dict | list | None = None,
    use_phonetic: bool = True,
) -> dict:
    """Trả về {normalized, matches:[Match...]} — text đã sửa + danh sách thay thế.

    aliases: ánh xạ "cách đọc lơ lớ" -> tên chuẩn, vd {"bọt tre": "Porsche", "ai phôn": "iPhone"}.
    Alias dùng cho brand tiếng Anh đọc lệch xa (fuzzy không bắt nổi).
    """
    if not text or (not catalog and not aliases):
        return {"normalized": text, "matches": []}

    words = text.split()
    n = len(words)

    # pairs = (chuỗi-để-SO-KHỚP, chuỗi-THAY-VÀO, is_alias)
    # catalog: fuzzy ngưỡng thường + gate ngoại lai. alias: ngưỡng CAO cố định (không gate).
    pairs: list[tuple[str, str, bool]] = [(c.strip(), c.strip(), False) for c in catalog if c and c.strip()]
    if aliases:
        items = aliases.items() if isinstance(aliases, dict) else aliases
        for spoken, canonical in items:
            if spoken and canonical:
                pairs.append((str(spoken).strip(), str(canonical).strip(), True))

    # Thu thập ứng viên: với mỗi pair, thử nhiều kích thước cửa sổ (vì STT tách/gộp từ
    # khác cách viết). So bằng _key (bỏ dấu + bỏ khoảng trắng).
    candidates: list[Match] = []
    for target, replacement, is_alias in pairs:
        target_key = _key(target, use_unidecode)
        if not target_key:
            continue
        target_phon = _phon_key(target) if use_phonetic else None
        kw = len(target.split())
        max_k = min(n, kw + 2)  # thử tới target_words + 2 từ
        for k in range(1, max_k + 1):
            for i in range(0, n - k + 1):
                seg = words[i:i + k]
                window = " ".join(seg)
                wk = _key(window, use_unidecode)
                # GUARD (đồng bộ với get_candidates) — CHỈ áp cho CATALOG, KHÔNG áp alias:
                # bỏ window có biên từ-đệm / khác nhóm-âm-đầu / quá ngắn so với brand.
                # → chặn "phở"→Fox (3 ký tự), "đi đâu"→Adidas ("đi" từ đệm), khác-âm-đầu...
                if not is_alias and _window_blocked(seg, wk, target, target_key):
                    continue
                score = fuzz.ratio(wk, target_key)
                if use_phonetic:
                    # khoá phụ phonetic VN->EN — lấy điểm cao nhất giữa 2 cách so
                    score = max(score, fuzz.ratio(_phon_key(window), target_phon))
                # Span ngắn (<4 ký tự) chỉ tự-thay khi gần-khít ≥90 (Fox→Fox), không nhận đồng âm.
                if not is_alias and _short_span_blocked(wk, score):
                    continue
                # Alias: ngưỡng CAO cố định (khớp gần tuyệt đối, không gate) → không leak.
                if is_alias:
                    eff = _ALIAS_THRESHOLD
                else:
                    # Catalog — Gate ngoại lai: cụm ngoại lai → nới ngưỡng (tiếng Việt giữ ngưỡng gốc).
                    eff = threshold
                    if use_phonetic and _window_is_foreign(window):
                        eff = max(_FOREIGN_FLOOR, threshold - _FOREIGN_DELTA)
                if score >= eff:
                    candidates.append(Match(window, replacement, round(score, 1), i, k))

    # Chọn tham lam: điểm cao trước, không chồng lấn nhau
    candidates.sort(key=lambda m: (-m.score, -m.length))
    used = [False] * n
    chosen: list[Match] = []
    for m in candidates:
        span = range(m.start, m.start + m.length)
        if any(used[j] for j in span):
            continue
        for j in span:
            used[j] = True
        chosen.append(m)

    # Áp dụng thay thế (từ phải sang trái để giữ chỉ số)
    chosen_by_pos = sorted(chosen, key=lambda m: m.start, reverse=True)
    out_words = words[:]
    for m in chosen_by_pos:
        out_words[m.start:m.start + m.length] = [m.replaced]

    matches = [asdict(m) for m in sorted(chosen, key=lambda m: m.start)]
    return {"normalized": " ".join(out_words), "matches": matches}

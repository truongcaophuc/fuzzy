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
_PHON_RULES = [("ph", "f"), ("qu", "w"), ("gi", "j"), ("oa", "wa"), ("oe", "we")]


def _phon_key(s: str) -> str:
    """Khoá so khớp PHỤ (phonetic VN->EN). Chỉ dùng để TÍNH ĐIỂM, không đổi text hiển thị."""
    t = unidecode(s).lower()
    for a, b in _PHON_RULES:
        t = t.replace(a, b)
    return "".join(t.split())


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
                window = " ".join(words[i:i + k])
                score = fuzz.ratio(_key(window, use_unidecode), target_key)
                if use_phonetic:
                    # khoá phụ phonetic VN->EN — lấy điểm cao nhất giữa 2 cách so
                    score = max(score, fuzz.ratio(_phon_key(window), target_phon))
                # Alias: ngưỡng CAO cố định (khớp gần tuyệt đối, không gate) → không leak.
                if is_alias:
                    eff = _ALIAS_THRESHOLD
                else:
                    # Catalog — Gate ngoại lai: cụm chứa token không-phải-tiếng-Việt → nới ngưỡng
                    # (từ tiếng Việt thật giữ ngưỡng gốc → không bị sửa nhầm).
                    # GUARD: chỉ nới khi cụm đủ dài so với brand — token ngắn (vd "dia" 3 ký tự)
                    # hạ ngưỡng sẽ match nhầm brand bất kỳ (Adidas...) → giữ ngưỡng gốc cho cụm ngắn.
                    eff = threshold
                    if use_phonetic and _window_is_foreign(window):
                        wk = _key(window, use_unidecode)
                        if len(wk) >= 4 and len(wk) >= 0.6 * len(target_key):
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

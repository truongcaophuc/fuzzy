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
) -> dict:
    """Trả về {normalized, matches:[Match...]} — text đã sửa + danh sách thay thế."""
    if not text or not catalog:
        return {"normalized": text, "matches": []}

    words = text.split()
    n = len(words)
    catalog = [c for c in (c.strip() for c in catalog) if c]

    # Thu thập ứng viên: với mỗi term, thử nhiều kích thước cửa sổ (vì STT tách/gộp từ
    # khác cách viết catalog). So bằng _key (bỏ dấu + bỏ khoảng trắng).
    candidates: list[Match] = []
    for term in catalog:
        term_key = _key(term, use_unidecode)
        kw = len(term.split())
        max_k = min(n, kw + 2)  # thử tới term_words + 2 từ
        for k in range(1, max_k + 1):
            for i in range(0, n - k + 1):
                window = " ".join(words[i:i + k])
                score = fuzz.ratio(_key(window, use_unidecode), term_key)
                if score >= threshold:
                    candidates.append(Match(window, term, round(score, 1), i, k))

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

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
    aliases: dict | list | None = None,
) -> dict:
    """Trả về {normalized, matches:[Match...]} — text đã sửa + danh sách thay thế.

    aliases: ánh xạ "cách đọc lơ lớ" -> tên chuẩn, vd {"bọt tre": "Porsche", "ai phôn": "iPhone"}.
    Alias dùng cho brand tiếng Anh đọc lệch xa (fuzzy không bắt nổi).
    """
    if not text or (not catalog and not aliases):
        return {"normalized": text, "matches": []}

    words = text.split()
    n = len(words)

    # pairs = (chuỗi-để-SO-KHỚP, chuỗi-THAY-VÀO)
    pairs: list[tuple[str, str]] = [(c.strip(), c.strip()) for c in catalog if c and c.strip()]
    if aliases:
        items = aliases.items() if isinstance(aliases, dict) else aliases
        for spoken, canonical in items:
            if spoken and canonical:
                pairs.append((str(spoken).strip(), str(canonical).strip()))

    # Thu thập ứng viên: với mỗi pair, thử nhiều kích thước cửa sổ (vì STT tách/gộp từ
    # khác cách viết). So bằng _key (bỏ dấu + bỏ khoảng trắng).
    candidates: list[Match] = []
    for target, replacement in pairs:
        target_key = _key(target, use_unidecode)
        if not target_key:
            continue
        kw = len(target.split())
        max_k = min(n, kw + 2)  # thử tới target_words + 2 từ
        for k in range(1, max_k + 1):
            for i in range(0, n - k + 1):
                window = " ".join(words[i:i + k])
                score = fuzz.ratio(_key(window, use_unidecode), target_key)
                if score >= threshold:
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

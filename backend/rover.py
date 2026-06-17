"""ROVER — gộp nhiều transcript bằng bỏ phiếu TỪNG TỪ (có trọng số).

Cách làm (progressive alignment, đơn giản hoá cho N nhỏ):
1. Lấy hệ trọng số cao nhất làm "cột nền".
2. Căn (align) từng hệ còn lại vào cột nền bằng difflib → tạo các cột (mỗi cột = các từ
   cùng vị trí từ các hệ). insert/delete tạo cột mới / để trống.
3. Mỗi cột bỏ phiếu theo trọng số; nếu "phiếu trống" (hệ không có từ ở cột đó) thắng → bỏ từ.
"""

from __future__ import annotations

from collections import defaultdict
from difflib import SequenceMatcher


def _rep(col: dict[int, str]) -> str:
    sc: dict[str, float] = defaultdict(float)
    for tok in col.values():
        sc[tok] += 1
    return max(sc, key=sc.get)


def rover_merge(token_lists: list[list[str]], weights: list[float]) -> list[str]:
    """token_lists & weights đã sắp theo trọng số GIẢM DẦN (index 0 = hệ tốt nhất)."""
    n = len(token_lists)
    if n == 0:
        return []
    if n == 1:
        return list(token_lists[0])

    columns: list[dict[int, str]] = [{0: t} for t in token_lists[0]]
    for s in range(1, n):
        rep = [_rep(c) for c in columns]
        new = token_lists[s]
        sm = SequenceMatcher(a=rep, b=new, autojunk=False)
        nc: list[dict[int, str]] = []
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag in ("equal", "replace"):
                ai, bj = list(range(i1, i2)), list(range(j1, j2))
                for k in range(max(len(ai), len(bj))):
                    col = dict(columns[ai[k]]) if k < len(ai) else {}
                    if k < len(bj):
                        col[s] = new[bj[k]]
                    nc.append(col)
            elif tag == "delete":
                for i in range(i1, i2):
                    nc.append(dict(columns[i]))
            elif tag == "insert":
                for j in range(j1, j2):
                    nc.append({s: new[j]})
        columns = nc

    total = sum(weights)
    out: list[str] = []
    for col in columns:
        sc: dict[str, float] = defaultdict(float)
        for sysidx, tok in col.items():
            sc[tok] += weights[sysidx]
        null_w = total - sum(weights[k] for k in col)   # hệ vắng mặt = bỏ phiếu "trống"
        win = max(sc, key=sc.get)
        if null_w > sc[win]:
            continue  # phiếu trống thắng → bỏ từ này
        out.append(win)
    return out

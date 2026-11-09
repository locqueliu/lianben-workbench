"""Culture lexicon (ported from reference preflight_culture_check.py, lines 21-53).

Terms are copied verbatim (no deletions); each gets category + confidence
(hard|ambiguous). Source: reference/script-refinement-workflow/tools/
preflight_culture_check.py:21-53.
"""
from __future__ import annotations

# preflight_culture_check.py:21-26
ACTION_HARD_TERMS = (
    "双膝跪地", "双膝下跪", "双膝跪倒", "三跪九叩", "跪地叩首",
    "叩首", "磕头", "行跪礼", "跪礼", "跪叩",
    "稽首", "顿首", "打千", "跪安", "道万福", "万福礼", "敛衽",
    "拱手礼", "作揖礼", "抱拳礼",
)
# preflight_culture_check.py:29-32
ACTION_AMBIGUOUS_TERMS = (
    "跪地", "长跪", "跪伏", "伏地跪", "跪坐", "正坐",
    "五体投地", "合十", "请安",
)
# preflight_culture_check.py:35-44
HARD_TERMS = (
    "筷子", "筷架", "一筷之礼", "筷礼",
    "拱手", "作揖", "跪拜", "拂袖", "抱拳",
    "旗袍", "长衫", "汉服", "唐装", "绣花鞋",
    "青砖", "瓦檐", "纸窗", "灯笼", "屏风", "太师椅",
    "客栈", "茶楼", "衙门", "祠堂", "四合院",
    "春节", "中秋", "饺子", "茶道",
    "皇上", "王爷", "银两", "铜钱",
    "古筝", "琵琶", "二胡", "古琴", "笛子", "唢呐", "京剧",
) + ACTION_HARD_TERMS
# preflight_culture_check.py:47-51
AMBIGUOUS_TERMS = (
    "中式", "古装", "宫廷",
    "家主", "老爷", "师父", "师兄", "掌柜", "店小二",
    "胡同", "弄堂", "书院", "科举", "镖局", "江湖",
) + ACTION_AMBIGUOUS_TERMS

ACTION_TERMS = set(ACTION_HARD_TERMS + ACTION_AMBIGUOUS_TERMS)

_CATEGORY = {
    # 器物
    "筷子": "器物", "筷架": "器物", "一筷之礼": "器物", "筷礼": "器物",
    "灯笼": "器物", "屏风": "器物", "太师椅": "器物", "青砖": "器物",
    "瓦檐": "器物", "纸窗": "器物", "茶道": "器物", "银两": "器物",
    "铜钱": "器物", "古筝": "器物", "琵琶": "器物", "二胡": "器物",
    "古琴": "器物", "笛子": "器物", "唢呐": "器物", "中式": "器物",
    # 服饰
    "旗袍": "服饰", "长衫": "服饰", "汉服": "服饰", "唐装": "服饰",
    "绣花鞋": "服饰", "古装": "服饰",
    # 称谓/制度
    "皇上": "称谓制度", "王爷": "称谓制度", "家主": "称谓制度",
    "老爷": "称谓制度", "师父": "称谓制度", "师兄": "称谓制度",
    "掌柜": "称谓制度", "店小二": "称谓制度", "衙门": "称谓制度",
    "祠堂": "称谓制度", "科举": "称谓制度", "镖局": "称谓制度",
    "江湖": "称谓制度", "宫廷": "称谓制度",
    # 节庆饮食
    "春节": "节庆饮食", "中秋": "节庆饮食", "饺子": "节庆饮食",
    # 礼仪动作（rest）
}

_TERMS: list[dict] = []


def _add(term: str, confidence: str) -> None:
    _TERMS.append({
        "term": term,
        "category": _CATEGORY.get(term, "礼仪动作"),
        "confidence": confidence,
    })


for _t in HARD_TERMS:
    _add(_t, "hard")
for _t in AMBIGUOUS_TERMS:
    _add(_t, "ambiguous")

# dedupe (some action terms appear in both lists conceptually)
_seen: set[str] = set()
UNIQUE_TERMS: list[dict] = []
for _e in _TERMS:
    if _e["term"] in _seen:
        continue
    _seen.add(_e["term"])
    UNIQUE_TERMS.append(_e)

# longest first for substring containment dedupe
UNIQUE_TERMS.sort(key=lambda x: len(x["term"]), reverse=True)


def match_terms(line: str, allowed: set[str]) -> list[dict]:
    """Longest-match (containment) term scan for one line."""
    hits = [e for e in UNIQUE_TERMS if e["term"] not in allowed and e["term"] in line]
    kept: list[dict] = []
    for e in hits:  # already longest-first
        if any(e["term"] in k["term"] for k in kept):
            continue
        kept.append(e)
    return kept

# M1 合成剧本 fixtures（期望矩阵）

> 生成器：`tests/make_fixtures.py`（bundled Python 3.12.14 + python-docx 1.2.0）。重新生成：`python tests/make_fixtures.py`（固定序列，内容确定性）。
> 用途：`tests/acceptance_m1.py` 调用引擎 `python -m lianben2 preflight --root <临时项目> --source <fixture>` 后的断言基准。

## 文件

| 文件 | 说明 |
|---|---|
| `sample-20eps.docx` | 20 集完整夹具：标题页/人物小传/术语/大纲（第 1 集前）+ 20 集 × 3 场 |
| `sample-3eps.docx` | 快速夹具：3 集（正常 / 文化 / pacing+标点） |
| `expected-20eps.json` / `expected-3eps.json` | 机器可读期望（词数、blocked、risky 集） |

## sample-20eps 逐集矩阵

| 集 | 标题 | 场次 | 英文词数 | 台词(对白/VO/OS) | spoken 期望 | 主角 | 文化 | pacing | 标点 | 备注 |
|---:|---|---:|---:|---|---|---|---|---|---|---|
| 01 | 雾港 | 3 | 180 | 16/1/1 | PASS | OK | clean | ok | clean |  |
| 02 | 缆桩 | 3 | 150 | 13/1/1 | PASS | OK | clean | ok | clean |  |
| 03 | 冷光 | 3 | 220 | 20/1/1 | PASS | OK | clean | ok | must_fix | 全角标点（。，：/全角空格） |
| 04 | 旧账 | 3 | 130 | 11/1/1 | PASS | OK | clean | ok | clean |  |
| 05 | 暗流 | 3 | 260 | 24/1/1 | PASS | OK | clean | atom_risk | clean | 连续 4 条 △ → atom RISK |
| 06 | 锈味 | 3 | 120 | 10/1/1 | PASS | OK | clean | ok | clean |  |
| 07 | 空舱 | 3 | 60 | 4/1/1 | FAIL_BELOW | OK | clean | ok | clean | **<100 词 → FAIL_BELOW** |
| 08 | 回声 | 3 | 200 | 18/1/1 | PASS | OK | clean | ok | clean |  |
| 09 | 值班室 | 3 | 300 | 28/1/1 | PASS | OK | clean | ok | must_fix | 全角标点（。，：/全角空格） |
| 10 | 家宴 | 3 | 240 | 22/1/1 | PASS | OK | must_fix | ok | clean | **双膝跪地+叩首；台词含筷子 → must_fix** |
| 11 | 锈锁 | 3 | 170 | 15/1/1 | PASS | OK | clean | ok | clean |  |
| 12 | 潮汐表 | 3 | 420 | 40/1/1 | FAIL_ABOVE | OK | clean | ok | clean | **>350 词 → FAIL_ABOVE** |
| 13 | 失踪名单 | 3 | 140 | 12/1/1 | PASS | OK | clean | ok | clean |  |
| 14 | 断线 | 3 | 320 | 30/1/1 | PASS | OK | clean | dialogue_risk | clean | 连续 8 行对白 → dialogue RISK |
| 15 | 夜航 | 3 | 190 | 17/1/1 | PASS | OK | clean | ok | must_fix | 全角标点（。，：/全角空格） |
| 16 | 铁证 | 3 | 110 | 9/1/1 | PASS | OK | clean | ok | clean |  |
| 17 | 逆流 | 3 | 230 | 21/1/1 | PASS | OK | clean | ok | clean |  |
| 18 | 旁观者 | 3 | 160 | 14/1/1 | PASS | LOW_PROTAGONIST | clean | ok | clean | **林砚仅 1 场人物行、无台词 → LOW → blocked** |
| 19 | 雨幕 | 3 | 280 | 26/1/1 | PASS | OK | clean | ok | clean |  |
| 20 | 归港 | 3 | 210 | 19/1/1 | PASS | OK | clean | ok | clean |  |

## 结构不变量（全剧）

- 第 1 集标题前：剧名/人物小传/术语/分集大纲 → 进 `facts_lock.md`，不进任何一集。
- 每集：`第N集《标题》` + `Episode N: "Title"` + 3 场 `N-1 … N-3`；每场含 `人物：…`、≥1 个 `【…】`、`△` 行与中英成对台词。
- 中英台词格式：`角色（对白/VO/OS，表演提示）：中文` 紧接 `ROLE (DIALOGUE/VO/OS, hint): English`。
- 英文词数按引擎同款正则 `(?<![A-Za-z0-9])[A-Za-z]+(?:['’\-][A-Za-z]+)*(?![A-Za-z0-9])` 计。

## 设计锚点

| 锚点 | 集 | 期望检查结果 |
|---|---:|---|
| 词数不足 | 07 | `spoken_words` = FAIL_BELOW（<100） |
| 词数超限 | 12 | `spoken_words` = FAIL_ABOVE（>350） |
| 文化命中 | 10 | `culture` must_fix：`double-knee`/叩首（△, fixable）+「筷子」（中文台词, fixable=false） |
| 主角极少 | 18 | `protagonist` = LOW_PROTAGONIST → blocked_eps=[18]；林砚无台词 |
| 连续 △ | 05 | `pacing.atom_pacing` RISK（max_atom_run≥4） |
| 连续对白 | 14 | `pacing.dialogue_density` RISK（max_spoken_run≥8） |
| 英文全角标点 | 03/09/15 | `punctuation` RISK（`。`/`，`/`：`/全角空格 must_fix） |
| 双语/顺序 | 全剧 | G2 100% 无损；中英相邻成对、顺序与源一致 |

## sample-3eps 矩阵

| 集 | 标题 | 场次 | 英文词数 | 台词(对白/VO/OS) | spoken 期望 | 主角 | 文化 | pacing | 标点 | 备注 |
|---:|---|---:|---:|---|---|---|---|---|---|---|
| 01 | 雾港 | 3 | 140 | 12/1/1 | PASS | OK | clean | ok | clean |  |
| 02 | 缆桩 | 3 | 180 | 16/1/1 | PASS | OK | clean | ok | clean |  |
| 03 | 冷光 | 3 | 260 | 24/1/1 | PASS | OK | clean | ok | must_fix | 全角标点（。，：/全角空格） |

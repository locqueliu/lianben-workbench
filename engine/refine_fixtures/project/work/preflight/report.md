# 《sample-20eps》前置质检报告

- 生成时间：2026-11-06T18:38:24+08:00
- 源文件：sample-20eps.docx（sha256 3a835732a604…）
- 集数：20；检测模式：A；置信度：0.999
- 总状态：BLOCKED；blocked 集：[18]
- 检查阈值来源：default

## 检查阈值（effectiveCheckProfile）

- 来源：default（default=旧脚本阈值；project=项目 check-profile.json）
- spoken_words：min=100，max=350
- pacing：max_atom_run=4，max_atoms_per_spoken=3.0，dup_similarity=0.5，max_dup_pairs=1，max_spoken_run=8，min_atoms_per_spoken=0.5，spoken_floor=10
- culture：forbid_cn_elements=True，allowed_terms=[]

## 总览

| 项目 | 结果 |
|---|---|
| 英文有声台词词数（100–350/集） | PASS 18 集；FAIL 2 集（[7, 12]） |
| 英文台词标点（信息项） | must_fix 10 项；warn 0 项；风险集 [3, 9, 15] |
| △/对白密度（信息项） | △ 风险集 [5]；对白风险集 [14] |
| 主角覆盖（硬门槛） | 主角：林砚；blocked 集 [18]；borderline 无 |
| 文化背景（信息项） | must_fix 3 项；suspected 0 项；info 0 项 |

## 五检矩阵

| 集 | 词数 | 标点 | 节奏 | 主角 | 文化 | blocked |
|---|---|---|---|---|---|---|
| EP01 | PASS(180) | OK | OK | OK | OK | 否 |
| EP02 | PASS(150) | OK | OK | OK | OK | 否 |
| EP03 | PASS(220) | RISK | OK | OK | OK | 否 |
| EP04 | PASS(130) | OK | OK | OK | OK | 否 |
| EP05 | PASS(260) | OK | RISK | OK | OK | 否 |
| EP06 | PASS(120) | OK | OK | OK | OK | 否 |
| EP07 | FAIL_BELOW(60) | OK | OK | OK | OK | 否 |
| EP08 | PASS(200) | OK | OK | OK | OK | 否 |
| EP09 | PASS(300) | RISK | OK | OK | OK | 否 |
| EP10 | PASS(240) | OK | OK | OK | RISK | 否 |
| EP11 | PASS(170) | OK | OK | OK | OK | 否 |
| EP12 | FAIL_ABOVE(420) | OK | OK | OK | OK | 否 |
| EP13 | PASS(140) | OK | OK | OK | OK | 否 |
| EP14 | PASS(320) | OK | RISK | OK | OK | 否 |
| EP15 | PASS(190) | RISK | OK | OK | OK | 否 |
| EP16 | PASS(110) | OK | OK | OK | OK | 否 |
| EP17 | PASS(230) | OK | OK | OK | OK | 否 |
| EP18 | PASS(160) | OK | OK | LOW_PROTAGONIST | OK | 是 |
| EP19 | PASS(280) | OK | OK | OK | OK | 否 |
| EP20 | PASS(210) | OK | OK | OK | OK | 否 |

## 逐项明细

### 1. 英文有声台词词数

| 集 | 词数 | 结果 | 原因 | 英文行 | 中文行 | mixed |
|---|---:|---|---|---:|---:|---:|
| EP01 | 180 | PASS | within_range | 18 | 18 | 0 |
| EP02 | 150 | PASS | within_range | 15 | 15 | 0 |
| EP03 | 220 | PASS | within_range | 22 | 22 | 0 |
| EP04 | 130 | PASS | within_range | 13 | 13 | 0 |
| EP05 | 260 | PASS | within_range | 26 | 26 | 0 |
| EP06 | 120 | PASS | within_range | 12 | 12 | 0 |
| EP07 | 60 | FAIL_BELOW | below_minimum | 6 | 6 | 0 |
| EP08 | 200 | PASS | within_range | 20 | 20 | 0 |
| EP09 | 300 | PASS | within_range | 30 | 30 | 0 |
| EP10 | 240 | PASS | within_range | 24 | 24 | 0 |
| EP11 | 170 | PASS | within_range | 17 | 17 | 0 |
| EP12 | 420 | FAIL_ABOVE | above_maximum | 42 | 42 | 0 |
| EP13 | 140 | PASS | within_range | 14 | 14 | 0 |
| EP14 | 320 | PASS | within_range | 32 | 32 | 0 |
| EP15 | 190 | PASS | within_range | 19 | 19 | 0 |
| EP16 | 110 | PASS | within_range | 11 | 11 | 0 |
| EP17 | 230 | PASS | within_range | 23 | 23 | 0 |
| EP18 | 160 | PASS | within_range | 16 | 16 | 0 |
| EP19 | 280 | PASS | within_range | 28 | 28 | 0 |
| EP20 | 210 | PASS | within_range | 21 | 21 | 0 |

### 2. 英文台词标点

| 集 | 段落 | 字符 | 级别 | 次数 | 上下文 / 建议 |
|---|---:|---|---|---:|---|
| EP03 | 150 | 。 | must_fix | 1 | LIN YAN (DIALOGUE, voice low): Nobody saw him leave。 That name is on the list. / 改为半角句号「.」 |
| EP03 | 153 | 　 | must_fix | 1 | LIN YAN (VO, voice tight): Do　not touch it. The door was locked from inside. / 全角空格改为半角空格 |
| EP03 | 156 | ， | must_fix | 1 | LIN YAN (DIALOGUE, tail held back): Stay，close to me. That name is on the list. / 改为半角逗号「,」 |
| EP09 | 534 | 。 | must_fix | 1 | LIN YAN (DIALOGUE, voice low): The manifest looks wrong。 That name is on the list. / 改为半角句号「.」 |
| EP09 | 537 | 　 | must_fix | 1 | LIN YAN (VO, voice tight): Look　at the bollard. The door was locked from inside. / 全角空格改为半角空格 |
| EP09 | 540 | ， | must_fix | 1 | LIN YAN (DIALOGUE, tail held back): Nobody，leaves the dock. That name is on the list. / 改为半角逗号「,」 |
| EP15 | 1093 | 。 | must_fix | 1 | LIN YAN (DIALOGUE, voice low)： This is not rust。 That name is on the list. / 改为半角句号「.」 |
| EP15 | 1093 | ： | must_fix | 1 | LIN YAN (DIALOGUE, voice low)： This is not rust。 That name is on the list. / 英文台词分隔符改为半角冒号「:」 |
| EP15 | 1096 | 　 | must_fix | 1 | LIN YAN (VO, voice tight): Check　the north gate. The door was locked from inside. / 全角空格改为半角空格 |
| EP15 | 1099 | ， | must_fix | 1 | LIN YAN (DIALOGUE, tail held back): The，camera went dark. That name is on the list. / 改为半角逗号「,」 |

### 3. △/对白密度与节奏

| 集 | △数 | 台词行 | △/台词 | 最长△段 | 近似对 | 最长对白段 | 状态 |
|---|---:|---:|---:|---:|---:|---:|---|
| EP01 | 21 | 36 | 0.58 | 1 | 0 | 2 | OK |
| EP02 | 18 | 30 | 0.6 | 1 | 0 | 2 | OK |
| EP03 | 25 | 44 | 0.57 | 1 | 0 | 2 | OK |
| EP04 | 16 | 26 | 0.62 | 1 | 0 | 2 | OK |
| EP05 | 32 | 52 | 0.62 | 4 | 0 | 2 | RISK |
| EP06 | 15 | 24 | 0.62 | 1 | 0 | 2 | OK |
| EP07 | 9 | 12 | 0.75 | 1 | 0 | 2 | OK |
| EP08 | 23 | 40 | 0.57 | 1 | 0 | 2 | OK |
| EP09 | 33 | 60 | 0.55 | 1 | 0 | 2 | OK |
| EP10 | 28 | 48 | 0.58 | 2 | 0 | 2 | OK |
| EP11 | 20 | 34 | 0.59 | 1 | 0 | 2 | OK |
| EP12 | 45 | 84 | 0.54 | 1 | 0 | 2 | OK |
| EP13 | 17 | 28 | 0.61 | 1 | 0 | 2 | OK |
| EP14 | 32 | 64 | 0.5 | 1 | 0 | 8 | RISK |
| EP15 | 22 | 38 | 0.58 | 1 | 0 | 2 | OK |
| EP16 | 14 | 22 | 0.64 | 1 | 0 | 2 | OK |
| EP17 | 26 | 46 | 0.57 | 1 | 0 | 2 | OK |
| EP18 | 19 | 32 | 0.59 | 1 | 0 | 2 | OK |
| EP19 | 31 | 56 | 0.55 | 1 | 0 | 2 | OK |
| EP20 | 24 | 42 | 0.57 | 1 | 0 | 2 | OK |

### 4. 主角覆盖

| 集 | 场次 | 主角场次 | 场次占比 | 台词占比 | 动作占比 | 覆盖分 | 状态 | 原因 |
|---|---:|---:|---:|---:|---:|---:|---|---|
| EP01 | 3 | 3 | 1.0 | 0.667 | 0.095 | 0.719 | OK | - |
| EP02 | 3 | 3 | 1.0 | 0.733 | 0.111 | 0.742 | OK | - |
| EP03 | 3 | 3 | 1.0 | 0.682 | 0.08 | 0.721 | OK | - |
| EP04 | 3 | 3 | 1.0 | 0.692 | 0.062 | 0.72 | OK | - |
| EP05 | 3 | 3 | 1.0 | 0.692 | 0.094 | 0.726 | OK | - |
| EP06 | 3 | 3 | 1.0 | 0.667 | 0.067 | 0.713 | OK | - |
| EP07 | 3 | 3 | 1.0 | 0.667 | 0.111 | 0.722 | OK | - |
| EP08 | 3 | 3 | 1.0 | 0.7 | 0.087 | 0.727 | OK | - |
| EP09 | 3 | 3 | 1.0 | 0.667 | 0.091 | 0.718 | OK | - |
| EP10 | 3 | 3 | 1.0 | 0.667 | 0.071 | 0.714 | OK | - |
| EP11 | 3 | 3 | 1.0 | 0.706 | 0.1 | 0.732 | OK | - |
| EP12 | 3 | 3 | 1.0 | 0.667 | 0.067 | 0.713 | OK | - |
| EP13 | 3 | 3 | 1.0 | 0.714 | 0.059 | 0.726 | OK | - |
| EP14 | 3 | 3 | 1.0 | 0.688 | 0.094 | 0.725 | OK | - |
| EP15 | 3 | 3 | 1.0 | 0.684 | 0.091 | 0.723 | OK | - |
| EP16 | 3 | 3 | 1.0 | 0.727 | 0.071 | 0.732 | OK | - |
| EP17 | 3 | 3 | 1.0 | 0.696 | 0.077 | 0.724 | OK | - |
| EP18 | 3 | 2 | 0.667 | 0.0 | 0.105 | 0.354 | LOW_PROTAGONIST | dialogue_ratio 0.000 < 0.2 |
| EP19 | 3 | 3 | 1.0 | 0.679 | 0.097 | 0.723 | OK | - |
| EP20 | 3 | 3 | 1.0 | 0.714 | 0.083 | 0.731 | OK | - |

### 5. 文化背景

| 集 | 段落 | 类型 | 命中词 | 分类 | 级别 | 可修复 | 上下文 / 建议 |
|---|---:|---|---|---|---|---|---|
| EP10 | 637 | dialogue | 筷子 | 器物 | must_fix | 否 | 林砚(对白,声线压低)：把筷子放下。 / 台词逐字锁定，不能自动改；需人工修改源稿或由用户授权调整。 |
| EP10 | 671 | action | 双膝跪地 | 礼仪动作 | must_fix | 是 | △ 他双膝跪地，叩首三次，额头贴在冰冷的地面上。 / 确认是否为 SOURCE 已建立的跪礼；若未建立，改为单膝、蹲下、后退、低头等中性动作。 |
| EP10 | 671 | action | 叩首 | 礼仪动作 | must_fix | 是 | △ 他双膝跪地，叩首三次，额头贴在冰冷的地面上。 / 确认是否为 SOURCE 已建立的跪礼；若未建立，改为单膝、蹲下、后退、低头等中性动作。 |

## blocked 集

- EP18：LOW_PROTAGONIST — dialogue_ratio 0.000 < 0.2（不进入炼本）

## 格式合规与异常集

- 识别模式：A；置信度：0.999
- 异常集：无

## AI 审计

本阶段未调用 AI（0 LLM / 0 网络，ai_used=false）。

## 下一步

- 确认/修复 blocked 集或文化 must_fix 后重跑前置。
- 进入炼本阶段前，请确保源稿中台词与结构行保持锁定。

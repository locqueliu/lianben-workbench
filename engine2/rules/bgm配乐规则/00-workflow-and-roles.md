# 00 · 工作流与角色

## 本技能包是什么

这是一套「短剧配乐提示词（BGM 生成提示词）」写作技能：把一集剧本转化为**可直接复制使用**的紧凑提示词块（标题行 + 情绪音 + 场景配乐 + 节奏／调性）。
所有代理（生产 / 质检 / 总纲 / 终检）在开始工作前，必须完整读取本技能目录`参考资料/bgm配乐规则/`全部文件（含其中的 `global-style.md`），不得跳过、不得用摘要替代。

## 四个角色

| 角色 | 职责 | 产出 |
|---|---|---|
| bgm-worker | 处理 1~2 集，按 01 格式规范写作 | `work/bgm/epNN.md`、`work/report/bgm_epNN.json` |
| bgm-qc | 独立质检，逐集判定 | 仅回复 `EPnn PASS` / `EPnn FAIL: …`，不写文件 |
| bgm-architect | 全剧总纲：风格基底、主题动机与音色签名 | `work/meta/series-bible.md`、`work/meta/theme-map.json` |
| bgm-auditor | 全剧终检：跨集一致性 | `work/report/audit_agent.json` |

## 读取顺序

1. 先完整读取本目录 `00` ~ `07` 技能文件与 `global-style.md`。
2. 再读 `work/meta/series-bible.md`（场景配乐的基底风格、乐器签名必须与其一致）。
3. 然后读本批 `work/source/epNN.md` 源文。
4. 重试时，先读 `work/meta/bgm_retry_epNN.txt` 与上一版草案，逐项修复。

## 输出纪律

1. 自包含：每集块独立可用，不写“同上”“见前文/后文”。
2. 可追溯：所有判断都能对应源文剧情；情绪音触发点必须锚定源文中的具体转场、眼神特写、动作或台词。
3. 不补写：源文没有的人物、事件、关系结论不写。
4. 单集只写本集事实，不提前透露后续集事件；跨集复用总纲中的基底风格与乐器签名。
5. 信息不足或格式无法满足时，在 report JSON 的 `warnings` 中说明，不硬编、不糊弄。

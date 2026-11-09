# 炼本工作台 · v1.0

DSH 插件：导入 .docx 剧本 → 机器前置弱质检 → 炼本（director）→ 配乐（BGM），
带异步 Job/SSE、实时输出、峰谷成本账本、token 预算、Word 占用硬化与旧项目迁移。

## 功能

- **导入/前置**：0-token 机器检查（英文台词词数/标点/△ 密度/主角覆盖/文化背景），blocked 硬门槛。
- **炼本**：8 phases refine Job；director 流式输出（炼本 tab 内嵌实时页）、check_ep 门禁、重试/降级、产物链与成本。
- **配乐**：9 phases BGM Job；bgm-architect/worker/qc/auditor、bgm_check_ep 门禁、QC/auditor 回炉、merge/build/final_audit；配乐 tab 内嵌实时输出。
- **成本/预算**：deepseek-flash 峰谷价实时计价；refine 每集 60K / BGM 每集 32K token 预算（含 25% 安全余量），80% 警告、100% needs_confirm。
- **硬化**：Word/WPS 占用 exit 3 → 30s×3 重试 → needs_confirm(word_locked)；旧插件/里程碑包移除后唯一入口。
- **迁移**：`migrate_legacy.py` + 页面「迁移旧项目」，只读复制旧项目并生成 `project.json`。

## 安装/升级

```text
plugin_manager install_bundle(target = <本目录绝对路径>)
```

v1 发布态：先卸载旧 `@local/lianben-workbench@0.5.0` 与 `-m1/-m2/-m3/-m4` 里程碑包，再安装本包；只保留一个 `lianben` 入口与 `lianben_workbench` 工具。刷新 Web GUI 后左栏打开「炼本工作台」。

## Agent 工具

`lianben_workbench`：health / list_projects / project / run_preflight / run_refine / run_bgm / job / cancel / selfcheck / refine / bgm。

## 测试/验证

- M4：bgm_prompt 64/64、bgm_tools 60/60、host_smoke_m4 12/12；合成 1 集冷启动 5 calls/55.3s/¥0.09267。
- M5：migrate_legacy_test 63/63、host_smoke_m3 18/18、pricing 12/12、refine prompt 56/56、refine tools 57/57；E2E 见 `tests/e2e_m5.py` 与 `docs/21-M5-实施与验证记录.md`。
- 真实用户项目只读：4 个项目 sha 不变；旧项目迁移只在副本上验证。

## 兼容/迁移

- 旧旧版 opencode 项目：页面「迁移旧项目」或 `python tools/migrate_legacy.py --source <old> --projects-root <lianben-projects> [--json]`。
- 旧 schema 由迁移器/打开时只读提示；v1 内 `project.json` 只增字段。

## 显式「按建议合并」（可选，确定性）

前置检查会为连续 △ 动作段给出合并建议；在前置 tab 的「△ 合并建议」卡片中可**显式选择集**并预览：

- 只把一段连续 △ 合并成 1 条 △；**不调用 LLM、0 token**；
- 台词、场次、人物、锁行和所有事实文字逐字节保留（仅去重复 △ 前缀，必要时插「；」）；
- 先预览（零写盘），再二次确认应用；合并前原文自动备份到 `work/merge/original/`，可一键恢复；
- 合并后前置报告为「合并前基线」，重跑前置会被拒绝（`MERGED_SOURCE`），需先恢复原文；
- 默认勾选检测为 RISK 的集；也可手动勾选其他含合并点的集。

### 可选：LLM 优化合并（默认关闭）

在「△ 合并建议」卡片可打开 **「使用 LLM 优化合并」** 开关（默认关闭）：

- 只有显式开启并点击预览才调用模型；一次最多 5 集；关闭时完全走确定性 0-token 合并；
- LLM 只优化选中的连续 △ 目标块；**台词、场次、人物、锁行和非目标行不改**；输出校验字符覆盖率（≥80% 才可通过，<98% 页面警告）；
- 预览只写 staging、**不写源稿**，显示模型/调用数/tokens/实际成本；应用必须使用该 previewId + 二次确认，**不会再次调用模型**；源稿预览后变化会拒绝应用；
- 应用后同样备份原稿、可一键恢复；合并后前置报告为合并前基线，重跑前置需先恢复；
- **批量合并**：LLM 开关开启时，可用「批量合并（全部 N 集）」按 5 集一批顺序预览全部选集；完成后一次确认应用所有批（一次备份/一次恢复），失败不部分写入。
- 真实模型成本与效果需先用 1 集预览验证，再扩大范围。

## 双模式：1.0 解说剧 / 2.0 演绎剧

项目库顶部可切换「1.0 解说剧」与「2.0 演绎剧」；项目创建后模式不可变，两个模式的项目互不可见/不可运行。

- **1.0**：弱质检 → director 逐集炼本 → 导演执行稿；保留合并/成本/迁移/BGM。
- **2.0**：弱质检 + 台词台账 + 可选低程度 LLM 纠正（导入页开关默认关闭；开启后不限集数、每集最多 2 次）→ planner/writer 双阶段分镜炼本 → 机器校验/返工 → 台词对账 → `_竖屏分镜稿.md/.docx`。2.0 BGM 已适配：同一 9-phase 配乐流程 + 2.0 规则包，输入 work/source，产物 _配乐方案.docx。
- **2.0 台账**：`work/meta/source_dialogue.tsv`；纠正会做逐句台词锁校验，失败回滚。
- **2.0 产物**：`output/<stem>_竖屏分镜稿.md/.docx`、`work/report/dialogue_audit.json`。
- 2.0 炼本目前支持抽样集（merge 自动 `--allow-partial`）与 A/B storyboard profile；真实 LLM 端到端需先用小样本验证。

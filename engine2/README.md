# engine2 · 2.0 演绎剧炼本引擎资产（迁移自 v2.0-yanyi-workflow）

> 本目录是 **2.0 演绎剧**（`v2.0-yanyi-workflow`）流程的确定性引擎资产，与 1.0 engine（`plugin/lianben-workbench/engine/**`）**完全隔离**。
> Host/Client 的 2.0 模式请使用本目录的 `tools/` 与 `rules/`；**不得**把本目录的 `tools/common.py` 与 1.0 `engine/tools/common.py` 混用/互相覆盖。

## 来源与版本

| 项 | 值 |
|---|---|
| 源目录 | `work/2.0/script-refinement-workflow-2.0-yanyi-workflow/`（只读参考，未修改） |
| 分支 | **`v2.0-yanyi-workflow`**（2.0 演绎剧炼本工作流；稳定基线 `main` = 1.0 解说剧） |
| commit | **`315ce3c`**（`docs/23-2.0-炼剧本可行性评估.md` 评估时 commit；源目录为导出副本、无 `.git`，无法再取完整 sha） |
| 归档 zip | `work/2.0/v2.0-yanyi-workflow.zip`，sha256 `0004060b9c257f8ebb460d9e6a4a5404aa412037a71ce1c3c1421fe4a102a3a7` |
| 迁移任务 | T2-A（task-39）：tools/规则/profile 移植 + 冒烟 |

## 目录内容

```text
engine2/
├─ README.md
├─ tools/                    # 27 个 Python 脚本（2.0 完整工具集，排除 __pycache__）
│  ├─ common.py              # 2.0 公共库（ROOT=脚本上级的上级；含文化硬锁词表等）
│  ├─ snapshot_dialogue.py   # 冻结源台词台账 work/meta/source_dialogue.tsv + meta.json（0 model）
│  ├─ audit_dialogue.py      # 台词对账（读台账 vs 成稿，写 work/report/dialogue_audit.json）
│  ├─ storyboard_check.py    # 竖屏分镜稿硬校验（0 token：分镜组/镜头时间轴/空间起点/标签/禁用字段）
│  ├─ storyboard_merge.py    # 分镜稿 Markdown 合并 → output/<stem>_竖屏分镜稿.md
│  ├─ storyboard_build_docx.py # 分镜稿 md → docx（Heading 映射）
│  ├─ preflight_*.py         # 2.0 前置检查（spoken/atom/culture）
│  └─ …                     # 其余 1.0 通用工具（check_ep/merge/writeback/bgm_* 等，2.0 修订版）
├─ rules/
│  ├─ storyboard/            # 分镜细则：00-contract.md / 01-planning.md / 02-craft.md
│  └─ preflight/preflight-reviewer.md  # 2.0 前置审查优化规则（供 prompt 参考）
└─ defaults/storyboard-profile.json    # 2.0 分镜参数默认值（部署到项目根 storyboard-profile.json）
```

## 部署方式（Host 2.0 模式）

脚本按 2.0 约定以 **`cwd = 项目根`** 运行；`common.ROOT = Path(__file__).resolve().parent.parent`，因此部署时必须把 `tools/` 整套复制到 **`<project>/tools/`**（与 1.0 的项目级副本一致）：

```text
<project>/tools/*.py                          ← engine2/tools/*.py（整套覆盖，勿混用 1.0 common.py）
<project>/storyboard-profile.json             ← engine2/defaults/storyboard-profile.json（项目未自定义时）
<project>/参考资料/分镜细则/*.md               ← engine2/rules/storyboard/*.md（prompt 注入用）
<project>/参考资料/审查优化规则/preflight-reviewer.md ← engine2/rules/preflight/preflight-reviewer.md
```

运行示例（cwd=项目根）：

```powershell
python tools/snapshot_dialogue.py                 # 台账：work/meta/source_dialogue.tsv + .meta.json
python tools/audit_dialogue.py                    # 对账：work/report/dialogue_audit.json
python tools/storyboard_check.py --dir work/storyboard
python tools/storyboard_merge.py
python tools/storyboard_build_docx.py
```

## 与 1.0 engine 的隔离

- **目录独立**：本目录不覆盖、不引用 `engine/**`；`index.js`/`client.js`/`prompts/**` 不属于本目录。
- **common.py 不同版本**：2.0 `engine2/tools/common.py` sha256 = `dc9264a805b5ed1c1b56996609ddd0eaedbd9803e8a640c16b3c5c2481f40e31`；1.0 `engine/tools/common.py` sha256 = `6ad5a0b25dc2c3a17835c0e1841cc74bb913f55ef127106fe48a3520e0d698d6`。**禁止**用 1.0 common.py 覆盖 2.0 部署副本（会把 2.0 分镜/表演规则与前置检查行为回退）。
- **0-token 边界**：本目录全部为确定性 Python，不调用 LLM；LLM 只发生在 2.0 prompt/agent 层（由 T2 prompt 任务提供，不在本目录）。
- **产物隔离**：项目产物仍写 `<project>/work/**`、`<project>/output/**`，与 1.0 项目路径一致；不写 `engine2/**`。

## 校验

```powershell
python tests/engine2_smoke.py
# PASS N/N → work/t2/engine2-smoke.json（0 LLM；fixture 复制自 work/2.0/eval-project）
```

冒烟覆盖：资产文件齐全与 copy 保真（sha256）· 无 `__pycache__` · 与 1.0 common.py 隔离 · `snapshot_dialogue` 在临时项目生成台账（TSV 行数/meta/40 集）· `storyboard_check --help` · 空 `work/storyboard` 给明确非 0 错误 · 用户/2.0 参考目录不被修改。

## 升级 2.0 资产

1. 从 `v2.0-yanyi-workflow` 新导出目录整体替换 `engine2/tools`、`engine2/rules`、`engine2/defaults`；
2. 更新本 README 的 commit / zip sha256；
3. 重跑 `python tests/engine2_smoke.py` 至 PASS，并同步 2.0 prompt 任务的资产版本。

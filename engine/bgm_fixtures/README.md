# bgm_fixtures —— 配乐工具链确定性联调夹具（0 LLM）

用于 M4-B：在没有 LLM/BGM worker 的情况下，验证旧配乐工具链在「项目内 tools 副本 +
项目内 `参考资料/bgm配乐规则`」布局下可确定性运行：

```
bgm_prepare.py
bgm_check_ep.py --eps 1            # 合格 mock 应 PASS；bad mock 应 FAIL(exit 1)
bgm_merge.py
bgm_build_docx.py
bgm_final_audit.py
```

执行与断言见 `tests/bgm_tools_smoke.py`，证据写入 `work/m4/bgm-tools-smoke.json`。

## 文件

| 路径 | 说明 |
|---|---|
| `project/` | 1 集（EP01）项目样本，复制自 `engine/refine_fixtures/project`：含 `work/source/ep01.md`、`work/meta/ep_index.json`（`docx` 字段存在）、`work/meta/progress.json`、单集 docx 与 `shot-profile.json`。刻意不含 `work/bgm/*`、`work/meta/bgm_*`、配乐报告等，供裸态准备与注入测试。 |
| `mock/series-bible.md` | mock 配乐总纲，含 `## 主题动机表`（`bgm_merge.py` 会抽取该段）。 |
| `mock/theme-map.json` | mock 主题动机表（`bgm_final_audit.py` 读取做一致性提示）。 |
| `mock/bgm_ep01.md` | 合格四行块（标题行 + 情绪音 / 场景配乐 / 节奏／调性），覆盖 EP01 全部 3 场（1-1/1-2/1-3），含调性 A小调、92 BPM、对白让位与留白收尾。 |
| `mock/bad_ep01.md` | 故意缺场次 ID 与调性的 bad 草稿，用于验证 `bgm_check_ep.py --eps 1` 返回 exit 1 且 fails 明确。 |
| `mock/bgm_ep01.json` | mock 单集机检结果（脚本会覆盖写 `bgm_check_ep01.json`，此文件用于完整 Host 写盘链路）。 |
| `mock/audit_agent.json` | mock 代理终检结论（`bgm_final_audit.py` 汇总读取）。 |
| `build_fixture.py` | 开发用重建脚本：从 `engine/refine_fixtures/project` 重新复制 `project/`；不参与运行时、不调用 LLM。 |

## 使用

`tests/bgm_tools_smoke.py` 会：
1. 复制 `project/` → 临时项目；复制 `engine/tools` → `<项目>/tools`；复制
   `engine/rules/bgm配乐规则` → `<项目>/参考资料/bgm配乐规则`（`bgm_common.REFS_DIR` 的固定路径）。
2. 裸态跑 `bgm_prepare.py`，断言 `work/meta/{bgm_index,bgm_digest,bgm_progress,bgm_manifest}` 生成。
3. 注入 `mock/*`，跑 `bgm_check_ep.py --eps 1` → PASS；`bgm_merge.py` / `bgm_build_docx.py`
   / `bgm_final_audit.py` → PASS，断言 `output/*_配乐方案.md/.docx` 与 `output/配乐终检报告.md`、
   `bgm_progress` 的 EP01 = passed、四行/场次齐全。
4. 用 `mock/bad_ep01.md` 复跑 `bgm_check_ep.py --eps 1`，断言 exit 1 且 fails 含
   `scene_missing` / `key_missing`。
5. 用不含 `参考资料/bgm配乐规则` 的项目跑 `bgm_merge.py`/`bgm_build_docx.py`，断言
   旧脚本给出明确错误（exit 2，提示缺少 global-style.md）而非静默降级。

## 重建

```powershell
<bundled-python> plugin/lianben-workbench-m3/engine/bgm_fixtures/build_fixture.py
```

仅重建 `project/`（mock 文件为手工维护的静态夹具）。

# refine_fixtures —— 无 LLM 炼本工具链联调夹具

用于 M3 确定性验证：Host 在没有 LLM/director 的情况下，也能把「mock director 输出」
落盘为 `work/draft/ep01.md`、`work/report/ep01.json`、`work/report/ep01_production_notes.md`，
然后跑通旧工具链：

```
check_ep.py --eps 1 --allow-issue-pass
merge.py --allow-partial
writeback_docx.py --allow-partial
final_audit.py --allow-partial
generate_summary.py
generate_qc_report.py
```

实际执行见 `tests/refine_tools_smoke.py`，证据写入 `work/m3/refine-tools-smoke.json`。

## 文件

| 路径 | 说明 |
|---|---|
| `project/` | 1 集（EP01）项目样本，由 `work/m2/acceptance/latest`（20 集弱质检前置项目）裁剪而来：仅保留 `work/source/ep01.md`、单集 docx、单集 meta/preflight 投影与 `shot-profile.json`。刻意**不含** `work/preflight/optimized/`、`work/draft/*`、`work/report/roundtrip.json`，用于验证旧脚本对弱质检新现状的容错。 |
| `mock-director-output.txt` | 哨兵格式的 mock director 输出（见下）。内容由 EP01 源文确定性地扩展而来：保留全部锁行/台词，补 `【景别…】`+`【人物站位…】` 哨兵块与 `SPECTACLE`，追加少量中性动作/环境描写作字数与原子覆盖；不含新增文化元素。 |
| `build_fixture.py` | 开发用重建脚本（不参与运行时、不调用 LLM）。依赖 workspace 内的 `work/m2/acceptance/latest`；若该目录不存在则仅能使用已生成夹具。 |

## mock 输出哨兵格式

`mock-director-output.txt` 按以下三个哨兵分段（严格匹配整行）：

```
===== DRAFT EP01 =====
<导演执行稿正文：首行第1集标题，锁行逐字保留，中英台词成对，镜头块哨兵齐全>

===== REPORT EP01 JSON =====
<work/report/ep01.json 的 JSON 内容（含 shot_plan.shots）>

===== PRODUCTION NOTES EP01 =====
<work/report/ep01_production_notes.md 的 Markdown 内容>
```

`tests/refine_tools_smoke.py` 解析该文件并注入到临时项目副本中，因此修改夹具后无需改脚本。

## 已知说明

- 夹具源文存在重复台词，旧 `common.spoken_order_errors()` 用 `str.find()` 全局首次匹配会把重复行误报为乱序（对源文自身都报错）。M3 在 `engine/tools/common.py` 做了最小补丁：按同语言同文本的第 k 次出现匹配，保留真实乱序检测。
- 该夹具只用于**工具链确定性**验证，不代表内容质量；mock 文本会刻意满足字数/原子/镜头块哨兵以让链路走绿，但不参与任何真实炼本交付。

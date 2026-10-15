# R14 终审报告：数据洞察与预警（对照 docs/round-14-plan.md）

审阅人：项目经理（pm-lead）｜工作区冻结待审（未提交，HEAD=b8e82ca）
方法：全量 `git diff` 通读 + **独立数值复算**（esbuild 打包 `src/insights.ts`/`reportCsv.ts`/`notifications.ts` 真实模块 → Node 探针自备期望值比对；探针为临时文件，已删除）+ 全套测试实跑。探针 3 项报错中 1 项（AC-10 转义）系本报告作者期望串写错，实际输出正确，已按实际正确值判定。

## 0. 独立实跑结果

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm test`（本机时区） | 8 文件 / 112 用例全绿 |
| `TZ=UTC npm test` | 8 文件 / 112 用例全绿（时区无关） |
| `cargo test` | 35 passed / 0 failed / 7 ignored |
| `cargo clippy --all-targets -- -D warnings` | exit 0（无告警） |
| `cargo fmt --all -- --check` | exit 0 |

独立复算关键值：AC-3 `totalDrop=90, spanDays=2, burnRate=45`；AC-11 `monthDrop=30, remainingDays=15, projectedTotal=62.14285714285714`（**与 §1.3/AC-11 一致，未回退到 64.29**）；§1.3 退化三分支（跳过 / degraded 不外推 / 正常外推）逐条复算正确。

## 1. AC-1..AC-12 判定表

| AC | 判定 | 证据 |
|---|---|---|
| AC-1 | 通过 | 探针：空历史 `hasData=false`；`InsightsPanel.tsx` L179-192 渲染「暂无历史数据」占位且不崩；窗口外快照 `hasData=false` |
| AC-2 | 通过 | 探针：单快照 `burnRate=daysLeft=null`、`reason=insufficientData`；JSON 无 NaN/Infinity |
| AC-3 | 通过 | 探针独立复算 100→50→80→40：`totalDrop=90 / spanDays=2 / burnRate=45`（非 30），无负值 |
| AC-4 | **不通过** | 洞察侧通过（探针：credits 组 `skipped=nonFiat`，账号列表不含 CREDITS）；**CSV 侧不通过**：探针实得 Kimi 账号 2 行。见 D-1 |
| AC-5 | **不通过** | 探针：`ok=false` 账号仍算出 `burnRate=25`，且被选入 `fastest`。见 D-2 |
| AC-6 | 通过 | 探针：默认阈值下余额 5 不提醒；阈值改 10 后同一数据立即得 `lowBalance`；`App.test.tsx` AC-6 用例通过 |
| AC-7 | 通过（附缺陷） | 探针：关开关后 kinds 仅剩 `refreshError`、lowBalance 问题键被清理，refreshError 保留 ✓；但存在副作用 D-3 |
| AC-8 | 通过 | cargo：`legacy_settings_json_without_r14_fields_loads_as_none`、`config::test_legacy_config_without_r14_fields_loads`、`r14_settings_fields_round_trip`、`partially_present_r14_fields_keep_values` 全绿；落盘为 camelCase |
| AC-9 | 通过（强度见 D-7） | `SettingsView.tsx#validateSettings`（保存前闸门）+ `types.rs#validate_settings`（save_config/import_config 兜底）；Rust 越界/非整数/NaN/Infinity 用例全绿 |
| AC-10 | 通过 | 探针实际 CSV：首字符 U+FEFF ✓、CRLF ✓、表头与 §4 逐字一致 ✓、`"中转站, ""主号"""` RFC4180 转义 ✓、无 dailyUsage 行的花费/请求/Token 为空串 ✓、无 undefined/NaN/null ✓ |
| AC-11 | 通过 | 探针复算 `projectedTotal=62.14285714285714 ≈ 62.1`；`remainingDays=15`（按 30 天月，非 16） |
| AC-12 | 通过 | 探针：同币种 3 账号取 burnRate 最大者（`slow:25/天`，`daysLeft=2`）、`risk=err`；`insights.test.ts` 覆盖 7→warn / 3→err |

公式与 §1 比对：§1.1 逐对差分只累计下降段 ✓；§1.2 `daysLeft=余额/速率` ✓；§1.3 `projected=monthDrop+burnRate×remainingDays` ✓；§1.4 分币种取最快、不进通知中心 ✓。§1.1 的 `calendarSpanDays`（insights.ts L198-203，本地日历天 + 日内占比）是文档 line 34 已记录的实现细化，复算与 AC-3/AC-11 期望一致，且本机时区与 TZ=UTC 两轮均绿。

## 2. 缺陷清单

**D-1（重要｜AC-4 未满足）credits 账号仍出现在 CSV 导出**
- 复现：Kimi（credits）账号 + 快照/每日用量 → `buildUsageCsv` 实得 2 行 credits 记录（探针 `AC4.creditsCsvRowCount=2`）。
- 位置：`src/reportCsv.ts` L126-127（按 accountIds 过滤，无币种跳过）；调用侧 `InsightsPanel.tsx` L167、`SettingsView.tsx` L158-160 传全部启用账号。
- 性质：**规格自身矛盾**——§4 line 72 写「每个启用账号」，AC-4 line 83 写「不出现在 CSV 行」；`reportCsv.test.ts` L180-188 显式锁定「credits 账号保留 CREDITS」，即实现按 §4 解释。责任在规格作者（本报告作者）。
- 建议：二选一 —— ①按 AC-4 原文修：生成时跳过币种为 credits/CREDIT 的行（约 2 行 + 1 断言）；②Lead 书面裁定 §4 口径优先，并把 AC-4 改写为「不进洞察指标；CSV 保留 credits 行」。

**D-2（重要｜AC-5 未满足）刷新失败账号仍产生洞察并可登上「消耗最快」摘要**
- 复现：`buildInsightReport(snaps, [{accountId:"bad",ok:false},{accountId:"good",ok:true}], …)` → 探针 `AC5.accounts=["bad:burn=25","good:burn=10"]`、`AC5.fastest=["bad"]`。
- 位置：`src/insights.ts` L264-279（只取 `o.accountId`，从不读 `o.ok`）；`InsightsPanel.tsx` L140-146（accountIds=全部启用账号）。注意 insights.ts L246 的 JSDoc 自称「刷新失败的账号不产生洞察」，与实现自相矛盾。
- 建议：二选一 —— ①`InsightsPanel` 只把 `statuses[id]?.ok === true` 的账号纳入 accountIds（约 2 行）；②裁定 AC-5 只约束「失败刷新不注入新数据点」（该点实现已满足：Rust 侧失败结果无 balance，不写快照），并改写 AC-5 文字。

**D-3（次要）关闭提醒总开关会凭空产生「已恢复」通知**
- 复现：阈值 USD=10、余额 5（存在 lowBalance 问题）→ 关闭 `notifyEnabled` 后重算 → 探针 `spuriousRecovered=["recovered:lowBalance:ds"]`。
- 位置：`notifications.ts#filterAlertsDisabled`（清理问题键）+ `App.tsx` L381-390（`diffRecovered` 以上轮问题键为基准）。
- 影响：提示「之前的『余额不足』提醒已解除」，实际只是关了开关；误导，非数据损坏。
- 建议：关闭开关时同时把提醒类问题键从 `prevProblemKeys` 基准剔除，或丢弃本轮属于提醒类的 recovered。

**D-4（次要）阈值滑块量程窄于规格合法区间，手改配置的合法值会被夹显**
- 位置：`SettingsView.tsx` USD 滑块 `max={100}`（规格 0–10000）、CNY `max={1000}`（规格 0–100000）；`ui/ThresholdSlider.tsx` L71 `clamp(value, lo, hi)`。
- 影响：手改 config.json 为 `notifyLowBalanceUsd: 5000`（合法）时界面显示 100；用户一拖动该滑块即把 5000 静默改写成 ≤100（渲染本身不回写）。
- 建议：滑块 max 与规格校验区间对齐，或超量程时以数字输入展示真实值并提示。

**D-5（次要／流程）实现期间修改了冻结规格 docs/round-14-plan.md**
- 事实：task-1 交付时 103 行，现 106 行，新增 §1.3「Lead 裁决（2026-10-15）」与 §1.1 line 34 的跨度口径细化（实现方写入；docs/ 本为 pm-lead 写入范围）。docs/ 未纳入版本控制，无 diff 记录。
- 建议：本轮接受（裁决已记录）；后续约定规格变更须由 Lead 明确指派 pm-lead 落笔。

**D-6（提示）`src-tauri/src/providers/official.rs` 的 100/100 行 diff 系测试模块整体位移**
- 事实：`#[cfg(test)] mod tests` 由 L46 移至 L599，内容逐行一致；`cargo test providers::official` → 4 passed（test_kimi_parse_form_ab/c、test_kimi_key_prefix_routing、test_encode_uri_component），无覆盖丢失。属 diff 噪音。

**D-7（次要）AC-9 的 UI 拒绝分支无自动化测试且实际不可达**
- 事实：ThresholdSlider 的 range/number 均先 clamp+snap 再 emit（L90-92、L129），量程内无法产生越界值，`validateSettings` 的拒绝分支只能由 `import_config` 或手改配置触发；该 TS 函数无单测，Rust 侧越界用例已覆盖。
- 建议：补一个 `validateSettings` 纯函数单测，或明确 UI 校验为纵深防御、由 Rust 测试背书。

## 3. 越界改动清单

- **发现 1 项越界**：`docs/round-14-plan.md` 被实现方修改（D-5，Lead 已部分追认）。
- 美工：仅新增 `src/components/ui/**`（MiniSparkline / SegmentedControl / StatTile / ThresholdSlider / index.ts）与 `src/styles.css`，未发现改动既有组件 ✓
- 开发 A：改动集中于 `src/App.tsx`、`App.test.tsx`、`api.ts`、`notifications.ts`、`types.ts`、`components/{Dashboard,SettingsView,InsightsPanel}.tsx` 及新增模块，均在 `src/**`（未动 ui/、styles.css、src-tauri/）✓
- 开发 B：改动集中于 `src-tauri/**`（types/commands/config/lib/net_tests/providers/official）+ `config.example.json`，未动 `src/**` ✓
- 契约核对：Settings 5 字段 snake_case ↔ camelCase 精确对应 ✓；旧配置无迁移可加载 ✓；`export_csv(path, content) -> Result<(), String>` 与裁决一致、前端 `invoke("export_csv", {path, content})` 对应 ✓；BalanceSnapshot 仍是 4 字段（`balance_snapshot_shape_is_unchanged` 全绿）✓。

## 4. 结论

- **不建议在现状下直接打包推送**：AC-4、AC-5 两条验收标准未按原文满足，且均有实测复现；按「AC 全数通过」的验收门禁不成立。
- 二者均非崩溃／数据损坏／安全级阻断，修复量各约 1–3 行 + 1 个断言。若 Lead 裁定按 §4 口径接受 AC-4、按「失败刷新不注入新数据点」口径接受 AC-5，则本报告转为「通过」：其余 10 条 AC、契约兼容、越界范围与全套测试（tsc / vitest×2 时区 / cargo test / clippy / fmt）均无阻断问题。
- 建议顺序：Lead 裁定 D-1/D-2 口径 → （如需）派开发 A 修 2 处并补断言 → 重跑 `npm test` + `cargo test` → 复验后推送；D-3/D-4 建议一并修或明确延后。

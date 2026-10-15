# R14 聚焦复验报告（task-9）

复验对象（哈希锁定，均为本轮门禁实跑时的修订）：`insights.ts 66dbd695afa7`、`reportCsv.ts 1e8f26641ce6`、`notifications.ts 71256154f96e`、`ui/ThresholdSlider.tsx bb1c184b5f12`(170 行)、`styles.css 97ebc253e0ad`(相对 HEAD 452/0)、`SettingsView.tsx 9d1eced29ed0`、`App.tsx c04549981fe5`。门禁运行前后哈希一致（PRE==POST），即门禁期间无写入。

> ⚠ **并发写入事实**：复验期间工作区**并非冻结**。`styles.css` 由 437/0 变为 452/0，`ThresholdSlider.tsx` 由 162 行变 170 行（mtime 17:20:15 / 17:20:31，晚于 17:19:38 的首轮 vitest）。按 Lead 说明系美工并行样式/可达性复核 + dev A 的 D-4 授权改动。本报告结论基于上列哈希的**最新修订**，并已重跑全套门禁。

## 1. 逐条结论

| 项 | 结论 | 关键证据（自备期望值的探针 / 实跑） |
|---|---|---|
| D-1 | **已修复** | 纯 credits 账号 0 行；`CREDIT` 单数 0 行；混合账号（两日均有快照）只出法币日 USD 行 |
| D-2 | **已修复** | 显式 `ok=false` 账号不在 accounts / skipped / fastest；`projection.accountCount=1` |
| D-3 | **已修复** | 关开关：recovered 仅 `refreshError:relay`；开开关：两者都在（无回归） |
| D-4 | **已修复**（附 N-2 残留说明） | 契约未破；渲染阶段不 `onChange`；5000/60000 如实显示（量程已对齐规格 10000/100000） |
| D-5 | **已落位** | §4 含「仅法币账号」；§7「变更历史」存在；AC-4/AC-5 原文未改写；文档 118 行 |
| D-7 | **已修复** | 新增 `validateSettings.test.ts`（15 用例：越界/NaN/Infinity/非整数拒绝 + 边界通过 + null/旧配置兼容） |
| **AC-4** | **转通过** | 见 §2 |
| **AC-5** | **转通过** | 见 §3 |

## 2. AC-4 复算证据（esbuild 打包真实模块 → Node 探针，期望值自备）

- 纯 credits 账号（快照 + dailyUsage 均 credits）→ 输出行 `[]`；`CREDIT` 单数 → `[]`；且 CSV 全文不含 `credits`/`CREDITS` 字样。
- 混合账号（同日既有 credits 又有法币快照的边界）→ 仅 1 行且为 `...,USD,2026-10-04,5,,,50`；credits 日不出行。
- 法币账号不受影响（回归）→ 正常出行。
- **与 `docs/round-14-plan.md` §4 一致性**：一致。实现比 §4 措辞更严（候选币种先剔除 credits 再取币种，并逐行复核当日币种），属"实现 ⊃ 规格"，非冲突；§4 措辞可再具体化（记入 N-2）。

## 3. AC-5 复算证据

- `accounts=["good:10"]`、`skipped=[]`、`fastest=["good"]`：失败账号 `bad` 三处均不出现。
- **无污染**：与「仅 good 账号」运行时逐值比较——`burnRate`、`projections[0].monthDrop`、`projectedTotal` 完全一致。
- 纯快照调用（`outcomes=[]`）→ `bad`/`good` 均参与（不受限，符合 §1 新增「统计范围」行）。
- 设计判断复核（无 statuses 条目的账号仍参与）：`accountIds` 显式给出、`outcomes` 只含 `good` 时，`bad` 仍参与 ✓，与 §1 措辞一致。**评估：可接受** —— 无 status 条目 = 本会话尚未刷新（刚启动只读到历史结果），并非失败；若按失败处理会在启动瞬间清空全部历史洞察。误导风险仅剩「最后一次刷新失败 → 其洞察隐藏」，这正是 AC-5 的要求，不存在把失败账号当正常展示的路径。

## 4. 新发现问题

**N-1（次要）混合账号「credits 花费日无当日快照」的行被标注为账号级法币**
- 复现：`dailyUsage=[{2026-10-02,cost 900,costUnit credits},{2026-10-04,cost 5,costUnit USD}]` + 仅 10-04 有快照 → 实得 `混合二号,new-api 系中转,USD,2026-10-02,900,,,`（花费实为 credits，币种列写 USD）。
- 位置：`src/reportCsv.ts` L171（`snap ? snap.currency : currency`，无快照时不参考当日 `costUnit`）。
- 影响：仅混币账号的细分场景标签不准；**不影响 AC-4 已覆盖的三种情形**（纯 credits / CREDIT 单数 / 混合且有快照）。
- 建议：该行无快照时优先取当日 `costUnit`（非法币则用账号币种，为 credits 则跳过该行），或明确记为已知限制延后。

**N-2（观察，非缺陷）** ① §4 措辞比实现略欠具体（见 §2）；② `ThresholdSlider` 数字框「聚焦后失焦但不输入」仍会走 `commitText`，把超量程值钳到滑块上界——因 `SettingsView` 滑块量程已与规格合法区间对齐（10000/100000），该路径仅对手改超限配置可达，影响可忽略；提示文案「数值本身未被修改」在渲染语义下成立。

## 5. 越界复核（任务第 7 条）

- `ui/ThresholdSlider.tsx`：props 契约 10 项**签名与类型未变**（label/value/min/max/step/unit/hint/disabled/id/onChange/className）；D-4 展示逻辑（displayValue/current/outOfRange）完整；新增 `noticeId` + `aria-describedby` + `role="status"`（可达性），配套 `.threshold-notice` 已在 `src/styles.css` L3375 定义 → 无"未定义样式"回归。
- 其余 4 个 ui 文件（MiniSparkline / SegmentedControl / StatTile / index.ts）mtime 为 16:12–16:13，早于修复窗口（17:11–17:20）→ 未被本轮改动 ✓（证据方式：mtime；`ui/` 未纳入版本控制，无法逐字 diff——如实标注证据强度）。
- **`styles.css` 与本条任务前提不符**：它被改动（437/0 → 452/0，mtime 最新）。按 Lead 说明属美工并行工作，非 dev A 越界；但"styles.css 未被本轮改动"不成立。
- `src-tauri/**` 与 `config.example.json` 的 numstat 与终审时逐字一致（Rust 侧本轮零改动）。

## 6. 门禁实跑（最新哈希，运行前后哈希一致）

`npx tsc --noEmit` 0；`npm test` **148/148**（本机时区）；`TZ=UTC npm test` **148/148**；`cargo test` **35 passed / 0 failed / 7 ignored**；`cargo clippy --all-targets -- -D warnings` 0；`cargo fmt --all -- --check` 0。

## 7. 结论

**建议推送** —— 条件是把本报告锁定的哈希作为最终产物，且推送前确认写入已停止（本轮已实际发生并行写入；若 `styles.css` 或 `ui/` 再有任何改动，须重跑 §6 门禁）。

AC-4、AC-5 均已转**通过**；D-1/D-2/D-3/D-4/D-5/D-7 经独立复算全部属实修复；无功能回归（AC-3 = 45/天、AC-11 = 62.14285714285714 复算一致）。唯一新发现 N-1 为**次要**且不在 AC-4 规定情形内，可作为已知限制延后；若要零瑕疵，修 `reportCsv.ts` L171 一行 + 1 断言即可。

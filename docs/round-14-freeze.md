# R14 推送前冻结复验（task-12）

复验人：项目经理（pm-lead）｜范围：只写本文件，未改任何 `src/**`、`src-tauri/**`、plan/review/reverify。

## 结论：**建议推送**

前提：本结论**仅对 §1 列出的哈希有效**。若此后 `src/**`、`src-tauri/**`、`src/styles.css` 再有任何写入，须重跑 §2 门禁。Lead 仅改版本号文件（`package.json` / `tauri.conf.json` / `Cargo.toml`）不影响本结论。

## 1. 冻结与哈希（PRE==POST 证明）

门禁**开始前**与**结束后**各跑一次同一哈希脚本（`node docs/.probe/hash.cjs`，29 个受审文件，输出 sha256 前 16 位），`Compare-Object` 结果：**PRE==POST（门禁期间无写入）**。

终版哈希（sha256 前 16 位）：

| 文件 | 哈希 |
|---|---|
| `src/insights.ts` | `66dbd695afa72b7d` |
| `src/reportCsv.ts` | `48dfd5ab431d4e31` |
| `src/reportCsv.test.ts` | `552b18d2d0966959` |
| `src/notifications.ts` | `71256154f96e1fa0` |
| `src/components/ui/ThresholdSlider.tsx` | `767790278388d90b` |
| `src/components/ui/ThresholdSlider.test.tsx` | `444f2cea2489012b` |
| `src/styles.css` | `97ebc253e0ad50e7` |
| `src/App.tsx` | `c04549981fe579a2` |
| `src/components/SettingsView.tsx` | `9d1eced29ed05ac4` |
| `src/components/InsightsPanel.tsx` | `e47170def3d23142` |

## 2. 全套门禁实跑（门禁窗口内，见 §1 哈希夹逼）

- `npx tsc --noEmit` → **exit 0**
- `npm test`（本机时区）→ **157/157 通过**（10 文件）
- `TZ=UTC npm test` → **157/157 通过**（CI 口径）
- `TZ=America/New_York npm test` → **157/157 通过**（夏令时口径）
- `cargo test` → **35 passed / 0 failed / 7 ignored**
- `cargo clippy --all-targets -- -D warnings` → **exit 0**（无告警）
- `cargo fmt --all -- --check` → **exit 0**
- 残留检查：`src/`、`src-tauri/` 下无 `*.bak` / `*.tmp` / `*.orig`

## 3. 目标性复验（独立探针，期望值自备，不复用仓库断言）

临时 vitest 配置 + 自写测试（`docs/.probe/`，跑完已删除）：**11/11 通过**。

- **D-8（失焦静默钳制）**：`value=50000, max=10000` → 渲染 `onChange` 未被调用、数字框显示 `50000`（未被夹成 10000）、滑块停在上界 `10000`；`focus → blur` **不输入** → `onChange` 仍未被调用、显示仍为 `50000`；显式输入 `250` 再失焦 → 恰好回调 1 次且值 `250`；量程内值 `focus→blur` 亦不回调。a11y 结构完好：`role="status"` 提示含「超出滑块范围」「数值本身未被修改」，`className` 含 `threshold-notice`，数字框与滑块 `aria-describedby` 均指向该提示 id。
  实现依据：`src/components/ui/ThresholdSlider.tsx` L97 `if (text.trim() === String(displayValue)) return;`。
- **N-1（CSV 混合账号币种误标）**：混合账号「credits 花费日且当日无快照」→ 该日**不出行**（且 CSV 全文无 `900`、无 `credits` 字样）；同账号法币日正常出行且币种为 `USD`；credits 日与法币日都有快照时仅法币日出行；纯 credits 账号 0 行；`CREDIT` 单数 0 行。
  实现依据：`src/reportCsv.ts` L114-128 `rowCurrencyOf`（当日 costUnit → 当日快照 currency → 账号级币种，任一命中 credits 即返回 null 跳过该行），调用点 L194。
- **回归**：AC-3 `totalDrop=90 / burnRate=45`；AC-11 `burnRate=30/14`、`remainingDays=15`、`projectedTotal=62.14285714285714`；AC-5 `ok=false` 账号不在 accounts/skipped/fastest 且 `projectedTotal` 与「仅 good」一致（`accountCount=1`）；AC-4 credits 账号不进洞察（`skipped=[{...nonFiat}]`）。

## 4. 越界复核

- 本轮（task-11）实际写入**仅 4 个文件**：`reportCsv.ts`、`reportCsv.test.ts`、`ThresholdSlider.tsx`、`ThresholdSlider.test.tsx`（mtime 17:25–17:26），均在开发 A 的 `src/**` 授权范围内，其中 `ThresholdSlider.tsx` 的改动为 D-8 明确授权。
- `styles.css`(mtime 17:20:31) 与 `ui/` 其它 4 文件属 task-10 美工授权改动（此前已在 task-9 复验中记录）。
- `src-tauri/**` 与 `config.example.json` 相对 HEAD 的 numstat 与终审时逐字一致 → 修复轮未触碰开发 B 范围。
- **越界例外：无。**

## 5. 已知限制（不阻断，仅记录备查）

1. `docs/round-14-plan.md` §4 措辞可比实现更具体（实现更严）；按 Lead 安排留到 R15 一并处理。
2. `rowCurrencyOf` 规则下，某日 `costUnit=credits` 而当日快照为法币时，该日**整行**不导出（连带该日余额快照不出现）——这是本轮裁决规则的直接结果，非缺陷。
3. `ok=false` 账号在失败期间不进投影，其所属币种的「本月预计支出」会随之缩小（AC-5 原文的固有结果）。

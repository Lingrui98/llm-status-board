# R16 复验 + 推送前冻结（task-29）

## 结论：**建议推送**

生效范围：本结论**仅对 §2 锁定哈希有效**；此后任何 `src/**`、`src-tauri/**`、`src/styles.css` 写入须重跑门禁。Lead 只改版本号文件（package.json / tauri.conf.json / Cargo.toml / Cargo.lock）不影响本结论。方法沿用上轮探针（只对 D-1/D-2 面新复算）+ 单次全套门禁 + PRE==POST；临时探针已删，**被审仓库零修改**。

## 1. D-1 / D-2 转**通过**

- **D-1（skipReason 语义）**：`systemNotify.ts:63` 联合类型改为 `"notSystemKind" | "notNew" | "disabled" | "suppressed" | "rateLimited"`；`:125` 开关关闭时返回 `skipReason: "disabled"`。探针实测**五个 reason 全部可达且各就各位**：`notSystemKind`(recovered) / `notNew`(已恢复 + 持续存在) / **`disabled`(开关关闭)** / `suppressed`(24h 内) / `rateLimited`(窗口满) / `send:true`；源码联合类型含 `"disabled"`；`systemNotify.test.ts:183-190` 已同步断言，无残留旧 `notNew` 断言。
- **D-2（IPC 副作用出更新函数）**：探针机械核对 —— `api.setAutoRefreshPaused` **调用点全仓仅 1 处**且在 `useEffect([autoPaused])` 内（`App.tsx:810`）；托盘监听器内**无 IPC**、只做纯翻转 `setAutoPaused(!autoPausedRef.current)`（`:402-404`）；`resumeAutoRefresh` 只 `setAutoPaused(false)`（`:792`）；`firstAutoPausedSyncRef` 跳过首次挂载（`:805-806`）。
  **暂停语义无变化**：前端仍是唯一真值源（Rust 只 emit）、翻转后按实际值回报、`autoRefreshSec===0` 行为不变、定时器门 `if (autoPausedRef.current) return`（`:507`）仍在 → 暂停只停定时器、手动刷新不受限。
  **取舍判定：「挂载不回报」正确**。两端初始态一致（前端 `autoPaused=false`，Rust `AtomicBool::new(false)`），挂载即回报属无收益的多余 IPC。**附带观察**：若将来出现「WebView 重新挂载而进程不重启」（开发态 HMR / 窗口重建）且此前处于暂停态，Rust 会短暂保留旧文案，直到下次暂停翻转才对齐 —— 届时可改为「挂载后无条件回报一次」，当前架构下不可达。

## 2. 锁定哈希（sha256 前 16；PRE==POST 证明门禁期间无写入）

| 文件 | 哈希 | 文件 | 哈希 |
|---|---|---|---|
| `src/App.tsx` | `86ebc2719c0b32f6` | `src-tauri/src/types.rs` | `94a78255f064693b` |
| `src/App.test.tsx` | `4ffbe5b91615318e` | `src-tauri/src/config.rs` | `91fcc38bed81d4ba` |
| `src/systemNotify.ts` | `339b265641da86b3` | `src-tauri/src/tray.rs` | `a1d0dd19286bb417` |
| `src/systemNotify.test.ts` | `31eee137f66bdc33` | `src-tauri/src/lib.rs` | `2d0a47cc13ad74ed` |
| `src/refreshRetry.ts` | `01eb8fda18940e59` | `src-tauri/src/commands.rs` | `a79ae7ee7b462ff2` |
| `src/pluginRuntime.ts` | `894b1497fcbc6f98` | `src-tauri/capabilities/default.json` | `7d54937de7c55485` |
| `src/autostart.ts` | `5cd82af0ac2fb4a9` | `src-tauri/Cargo.toml` | `2fa2b80f73a6855f` |
| `src/systemNotifyApi.ts` | `dbb1231be968f065` | `package.json` | `47dad61b8c51aae0` |
| `src/residentSettings.ts` | `12ab26d1e2521ee7` | `src/styles.css` | `c2d6f510d46f99e0` |

`ui/`：SettingRow `9c1e6b52c146d723`｜InlineNotice `bd5b52cac6601a30`｜ThresholdSlider `767790278388d90b`（本轮未改）。

## 3. 无回归抽测（复用上轮探针，未重跑全量 21 条 AC）

重试：`1000/2000/4000ms`、累计 `7000`、达上限 `schedule()` 返回 false、**重复 schedule 被拒（待执行 ≤1）**、`okCount=1` 的**部分失败不重试**（`okCount=0` 才重试）｜通知：24h 边界 `−1ms → suppressed`、`=86_400_000 → 发送`；窗口满时 `rateLimited` 且**不写抑制表、不计入速率**｜设置默认：`{enabled:true,max:1}`。
**Rust 侧本轮零改动**（`config.rs`/`tray.rs`/`types.rs`/`lib.rs` 哈希与 R16 终审完全一致）→ 上轮结论直接沿用：§7 空行兜底**不误删 B2 基准行**（入批+整账净化、`used_total!=null` 保留、字节幂等、无文件时不创建空文件）；托盘 `pause_menu_item`/`tooltip_text` 文案契约不变。

## 4. 门禁（单次，实跑）

`npx tsc --noEmit` 0｜`npm test` **329/329**（本机）｜`TZ=UTC npm test` **329/329**｜`cargo test` **68 passed / 0 failed / 7 ignored**｜`cargo clippy --all-targets -- -D warnings` 0｜`cargo fmt --check` 0｜`npx vite build` 成功，入口 `index-BXtxj_DQ.js`（287 KB）`recharts-` 命中 **0**。
**基线**：R15 冻结的 13 个测试文件对照 HEAD，253 条断言**删除/改动 = 0**（`App.test.tsx` 仅新增）。

## 5. 越界复核：无例外

本轮（task-28）写入仅 `src/App.tsx`、`src/App.test.tsx`、`src/systemNotify.ts`、`src/systemNotify.test.ts` —— 全在开发 A 的 `src/**` 授权范围内；`src-tauri/**`、`ui/**`、`styles.css` 哈希未变。PM 仅写 `docs/`。

## 6. 观察项（不阻断）

R16 终审的 D-3（窗口恢复 / ✕ 隐藏 / 托盘暂停点击需真机 GUI）在本机仍无法冒烟，建议推送后在打包产物上手工确认一次；本次修复未触及这些路径。

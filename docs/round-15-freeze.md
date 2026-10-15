# R15 复验 + 推送前冻结（task-21）

## 结论：**建议推送**

生效范围：本结论**仅对 §1 锁定哈希有效**。此后若 `src/**`、`src-tauri/**`、`src/styles.css` 再有写入须重跑门禁；Lead 只改版本号文件（package.json / tauri.conf.json / Cargo.toml）不影响本结论。方法：esbuild 打包真实模块 → Node 探针（期望值自备，跑 3 个时区）+ **独立 Rust harness**（临时副本注入自写测试）+ 全套门禁；临时探针与副本均已删除，**被审仓库零修改**。

## 1. 冻结：终版哈希（sha256 前 16）与 PRE==POST

门禁前后各跑一次同一哈希脚本（42 个受审文件），`Compare-Object` = **PRE==POST（门禁期间无写入）**。

| 文件 | 哈希 | 文件 | 哈希 |
|---|---|---|---|
| `src/usageHistory.ts` | `1c979e21ff3efdfc` | `src-tauri/src/config.rs` | `308f4f68d790a226` |
| `src/usageHistory.test.ts` | `1b6bb96e05505832` | `src-tauri/src/types.rs` | `0c1628344516e890` |
| `src/analysis.ts` | `deb8cfc9846afd35` | `src-tauri/src/commands.rs` | `666e1c7f2ce291df` |
| `src/App.tsx` | `ef9aea2425d6f108` | `src-tauri/src/lib.rs` | `c144554b771fe441` |
| `src/App.test.tsx` | `50d14f2671ebdc89` | `src/styles.css` | `d5111e5a5c708b2d` |
| `src/types.ts` | `708360f9cff3ec6d` | `src/components/ui/index.ts` | `b4ef3a5e068f37aa` |

`ui/` 原语：DeltaBadge `ec36ef48f2c9c7d2`｜HeatStrip `acebe54b52400f76`｜MiniBars `098abebacb94c849`｜RankingRow `a7a1d1fce3cd0616`｜StatTile `71f98463ee4260ae`｜MiniSparkline `c93f4c1685211ab6`｜SegmentedControl `cd4b4a34e2c7ed5c`｜ThresholdSlider `767790278388d90b`（本轮均未改动）。

## 2. AC-3 转**通过**（含 AC-9 未回归 —— 重点核对项）

- 全空行（`cost/requests/tokens/inputTokens/outputTokens/usedTotal` 全 null）**不再生成**：探针四账号输入中，全空账号产出 **0 条**（上轮为 1 条），`costOnly`/`partial`（只有请求数）/`tokOnly`（只有 token）**照常产出**；`isEmptyUsageRow` 判定 `allNull=true`、`usedOnly=false`（`usageHistory.ts` L83-99，过滤点 L148）。
- **AC-9 未被带崩**（你特别点名的「修一个坏另一个」）：仅 `usedTotal` 有值的 B2 基准行**仍然写入** —— 直接调用得 `{date,cost:0,usedTotal:500,source:"local"}`，且经 `buildUsageBatch` 端到端后**仍在批次内**（未被新过滤器误删）；第二次 `used=560` → `cost=60`，同状态重复仍 `60`（幂等）。这与 AC-9 口径澄清（首次观察写 `cost=0` 基准行）完全一致。

## 3. D-2 / D-3 / D-5 转**通过**

- **D-2（B2 日期=本地日历日）**：`2026-10-15T20:30Z` 场景下，探针三时区实测 `appPath` 与「该时区的本地日历日」逐一相等：`UTC → 2026-10-15`、`Asia/Shanghai → 2026-10-16`、本机（系统时区 Asia/Shanghai）→ `2026-10-16`；注入本地日键时原样使用。实现：`App.tsx` L247 `toLocalDateKey()` → L254 传入 → `usageHistory.ts` L229 用注入键（不再从 `toISOString()` 推 UTC 日）。
- **D-3（source 归一）**：独立 harness 实测 `"foo"`/`""`/`"SITE"` → 落盘 **`local`**，`"site"` 保留；既有 site 行 `cost=5` **不被脏值（99）覆盖**，真 site 仍可覆盖 local；`normalize_usage_source`（`config.rs` L273-280）在**合并之后**执行（合并判定用原始值）→ 脏值无覆盖能力。新增 `USAGE_SOURCE_LOCAL` 常量（`types.rs` L344）。
- **D-5（备份名冲突）**：harness 预置当前秒的同名备份（内容 `SENTINEL`）→ 触发自愈后：预置备份**原样保留**、本次新备份仍保留原始损坏内容 `###`；既有仓库测试 `test_backup_name_collision_uses_suffix_and_keeps_existing` 同时存在（`config.rs` L1195）。

## 4. 无回归（抽测复算）

AC-5 `90`（50+0+40）｜AC-6 跨日 `30` 记入后一笔日期｜AC-10 `delta=+20 / deltaPct=+40.0 / 日均 10 与 7.142857`｜AC-11 `A=12.5 > B=8`｜AC-12 `X=0.1 / Y=0.2 → 最差 Y`、请求 0 → `null`｜AC-13 `med=10 / 阈值 25 → 40（4.0×）`、样本 3 天 → 「样本不足」｜AC-1 空历史四项全空不崩。跨端契约字段集合仍 `same=true`（`UsageRecord` 11 字段、`UsageHistoryFile{version,records}`）。

## 5. 门禁实跑

`npx tsc --noEmit` 0｜`npm test` **253/253**（本机）｜`TZ=UTC npm test` **253/253**｜`cargo test` **54 passed / 0 failed / 7 ignored**｜`cargo clippy -D warnings` 0｜`cargo fmt --check` 0｜`npx vite build` 成功，入口 chunk `index-CpYybpm3.js`（270 KB）`recharts-` 命中 **0**，recharts 仅在懒加载 chunk（`generateCategoricalChart` 343 KB 等）。
**既有 157 条基线断言：逐文件对照 HEAD，删除/改动 = 0**（仅 `App.test.tsx` +5 新增）。

## 6. 越界复核：无例外

本轮实际写入仅：`src/App.tsx`、`src/App.test.tsx`、`src/usageHistory.ts`(+test)（开发 A，`src/**`，未动 `ui/`、`styles.css`）与 `src-tauri/src/{types,config}.rs`（开发 B）；`ui/**`、`styles.css`、`commands.rs`、`lib.rs`、`analysis.ts` 等哈希与上轮完全一致 → 未越界。

## 7. 观察项（不阻断）

1. Rust 存储层**没有**第二道「全空行」过滤（`config.rs` 无 `isEmpty` 判定），端到端安全目前由前端保证；若将来有其它写入方，建议在 Rust 侧补一道兜底（非本轮必须）。
2. 全局 20000 条回收只在单次 upsert 后执行，多账号长期运行下的分布（每账号 400 天上限先裁）已由测试覆盖，无需额外动作。

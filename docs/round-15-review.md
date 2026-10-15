# R15 终审报告：本地用量历史 + 深度分析（对照 `docs/round-15-plan.md`）

方法：全量 `git diff` 通读 + **独立复算**（esbuild 打包真实模块 → Node 探针，期望值自备，跑 3 个时区）+ **独立 Rust harness**（临时副本内注入自写测试，7 项存储不变量；`mod config` 非 pub，外部 crate 无法调用，故只能放副本）+ 全套门禁。临时探针与副本均已删除，**被审仓库零修改**。

## 0. 实测结果（门禁前后哈希 PRE==POST，无写入）

| 命令 | 结果 |
|---|---|
| `npx tsc --noEmit` | exit 0 |
| `npm test`（本机时区 / `TZ=UTC`） | **245/245**（13 文件）双时区全绿 |
| `npx vite build` | 成功；入口 chunk `index-Vfbs4ZGZ.js` 270 KB，`recharts-` 命中 **0**；recharts 仅在懒加载 chunk（`generateCategoricalChart` 343 KB 等）→ 懒加载边界未破 |
| `cargo test` | **52 passed / 0 failed / 7 ignored** |
| `cargo clippy --all-targets -- -D warnings` | exit 0 |
| `cargo fmt --all -- --check` | exit 0 |

## 1. AC-1..AC-16 判定

| AC | 判定 | 证据（探针实测值 / 行号） |
|---|---|---|
| AC-1 | 通过 | `buildAnalysis({records:[]})` → `hasUsageHistory=false`、四指标全空不崩；`AnalysisView` 空态有测试 |
| AC-2 | 通过 | 同日 `100→80` → 1 行 `cost=20`、`source="local"`、`currency=USD` |
| AC-3 | **不通过** | 强幂等 ✓（harness ①：字节 + mtime 均不变）；**「空日不写」✗**：全空行被生成且被持久化（`EMPTY_DAY_RECORDS_PERSISTED=1`）→ D-1 |
| AC-4 | 通过 | 探针 `mergeUsageRecords` 双向 → site 胜；harness ② 真实存储层同结论（local 值 99 也不覆盖 site 5） |
| AC-5 | 通过 | `100→50→80→40` → `cost=90`（50+0+40） |
| AC-6 | 通过 | 昨日 100 → 今日 70 → `30` 记入**后一笔快照的日期** |
| AC-7 | 通过 | harness ③：401 天 → 每账号保留 400（最旧丢、最新在、他账号不受影响）；20001 → 20000 丢最旧 |
| AC-8 | 通过 | harness ④：读路径 Err 含**文件路径**且文件仍是 `###`、不产生备份；写路径**恰好新增 1 个**备份、备份内含 `###`，日志打印备份名 |
| AC-9 | 通过 | 首次观察 → 基准行 `cost=0/usedTotal=500`；used→560 得 `cost=60`；同状态重复仍 `60`（幂等）；credits 不参与法币聚合 |
| AC-10 | 通过 | `delta=+20`、`deltaPct=+40`、日均 `10` 与 `7.142857`；prev=0 → 「新增」；皆 0 → 「—」 |
| AC-11 | 通过 | 跨账号同名合并 `A=12.5 > B=8`；`costUnit` 不同分成两榜；`cost=null` 进 noCost |
| AC-12 | 通过 | X `0.1` / Y `0.2` → 最差 Y；`requests=0` → `null` 不参与；USD/CNY/CREDITS 三组各成榜 |
| AC-13 | 通过 | 近 14 天 `13×10+40` → `med=10`、阈值 `25` → 40 命中（`4.0×`）；仅 3 天 → 「样本不足」 |
| AC-14 | 通过 | 三时区（本机 / UTC / Asia/Shanghai）探针 DIGEST **完全一致** |
| AC-15 | 通过 | 见 §2 对照表；两个 IPC 已注册 `lib.rs` L35-36 |
| AC-16 | 通过 | `UsageRecord` 无模型字段；`history.json` 格式/逻辑未改；`results.json` 仍是整体覆盖 |

## 2. 跨端契约逐字比对（机械化：解析两侧类型后 camelCase 规整比对）

- `UsageRecord` **11 字段两侧集合完全相同**（`same=true`）：`accountId`、`date`、`cost`、`currency`、`requests`、`inputTokens`、`outputTokens`、`tokens`、`usedTotal`、`source`、`updatedAt`。
- 可空性一致：`cost/requests/inputTokens/outputTokens/tokens/usedTotal` 双端可空；`accountId/date/currency/source/updatedAt` 双端必填；Rust 全字段 `serde(default)`，因而磁盘缺字段也能读、前端拿到的键恒为 11 个。
- 封套：`UsageHistoryFile{version, records}` 双端一致；Rust `USAGE_HISTORY_VERSION = 1`（= §1.1）。
- **枚举值：TS `"site" | "local"`；Rust 只有 `USAGE_SOURCE_SITE="site"`，无 LOCAL 常量、`source` 是 `String` 且无枚举校验 → D-3**（值本身一致，严格度不一致）。
- IPC：`get_usage_history(app) -> UsageHistoryFile` ↔ `invoke("get_usage_history")` ✓；`upsert_usage_history(app, records: Vec<UsageRecord>) -> usize` ↔ `invoke("upsert_usage_history", { records })` ✓。

## 3. Rust 存储不变量（独立 harness：临时副本 + 自写测试，**7 项全绿**）

① 同批次重复 upsert → 字节与 **mtime** 均不变 ② site 覆盖 local、local 永不覆盖 site（双向） ③ 每账号 400 天保最新 + 总量 20000 丢最旧 ④ 读损坏不动文件 / 写自愈先备份且备份保留原文 ⑤ `version>1` 拒绝且不覆盖 ⑥ 空币种归一作用于整份总账，归一后重复 upsert 不再写盘 ⑦ 空批次 + 无文件 → 不创建文件。

## 4. 缺陷清单

**D-1（重要｜唯一未达标 AC）AC-3「空日不写」未实现（R3）**
- 复现：站点 `dailyUsage` 含 `{date, cost:null, requests:null, tokens:null}` → `buildUsageBatch` 产出 1 条记录；送入 Rust 后 `EMPTY_DAY_RECORDS_PERSISTED=1`。
- 位置：`src/usageHistory.ts` L107-123（`siteRecordsFromOutcomes` 无空日过滤）+ L266（`buildUsageBatch` 不二次过滤）；Rust `config.rs` L323-329（upsert 无过滤）。
- 影响：总账出现全空行；异常日检测把这些行计为「有记录日、cost=0」，**压低中位数 → 可产生错误异常日信号或压制检测**；费用聚合不受影响（null 计 0）。
- 修法（约 1 行 + 1 断言）：在 `siteRecordsFromOutcomes` 内跳过 `cost===null && requests===null && tokens===null && inputTokens===null && outputTokens===null && usedTotal===null` 的行；**必须保留 `usedTotal != null` 的 B2 基准行**（AC-9 口径澄清）。

**D-2（次要）B2 行日期取 UTC 日历日而非本地日历日**
- 复现：`localRecordsFromUsedCounter([...], [], "2026-10-15T20:30:00.000Z")` → `date="2026-10-15"`；`TZ=Asia/Shanghai` 下该时刻本地日是 `2026-10-16`。
- 位置：`src/App.tsx` L186 传 `new Date().toISOString()`；`src/usageHistory.ts` L36-43（带 `Z` 的串取**自身时区**=UTC 日历日）+ L198。
- 影响：仅 `balance=null && used!=null` 的账号（Kimi 订阅），在 UTC 与本地跨日窗口（UTC+8 为本地 00:00–08:00）当日归属错位；总量仍累积，不影响其他账号/指标。
- 建议：B2 日期改用 `toLocalDateKey(new Date())` 或由调用方传本地日键。

**D-3（次要）`source` 两端严格度不一致**
- Rust `source: String`、无枚举校验、无 LOCAL 常量；TS 是联合类型。脏数据 `source:"foo"` 会被接受，且 `is_site()` 为 false → 被当作 local，可能覆盖真正的 site 行。
- 建议：Rust 写入前校验 `source ∈ {"site","local"}`（非法则拒绝或归一），并补 LOCAL 常量。

**D-4（观察）读路径不做币种归一**：`load_usage_history` 原样返回空币种行（§1.1「永不空串」仅在写路径成立）；分析层靠 `normalizeCurrency` 兜底为 `UNKNOWN`，不崩。建议读路径同样归一或明确口径。

**D-5（观察）备份同名冲突未测**：同秒二次自愈的 `while exists → -1/-2`（`config.rs` L191-194）实现正确但无测试覆盖。

## 5. 越界复核：无例外

- 美工：`styles.css`(+330) + `ui/{DeltaBadge,HeatStrip,MiniBars,RankingRow}.tsx` + `ui/index.ts`（diff 已核：仅新增 4 个原语导出）✓
- 开发 A：`types/api/App/App.test/Dashboard/charts/lazy/charts/AnalysisTrendChart/AnalysisView(+test)/analysis(+test)/usageHistory(+test)`，均在 `src/**`，未动 `ui/`、`styles.css`、`src-tauri/` ✓
- 开发 B：`src-tauri/src/{types,config,commands,lib}.rs` ✓
- PM：`docs/round-15-plan.md`（142 → 147 行，含 AC-8/AC-9 两处口径澄清）✓

## 6. 其他核对

- **既有 157 条基线断言：逐文件对照 HEAD，删除/改动 = 0**（仅 `App.test.tsx` +4 新增）。
- **`normalize_usage_currency` 作用于整份总账（item 7）：结论「可接受」** —— ①只把空串/空白 trim 成 `UNKNOWN`、不做大小写归一，不会重写合法币种；②位于合并 + 清理之后、写盘之前，可一次修复历史脏行；③幂等由「文本全等不写盘」保障（harness ⑥ 实测：归一后重复 upsert 不写盘、mtime 不变）；④唯一副作用是「空批次 + 存在空币种旧行」会触发一次修正性写入，属期望行为。

## 7. 结论

**不建议推送** —— 唯一阻断项：**AC-3「空日不写」未达标（D-1，重要，已实测到存储层）**。其余 15 条 AC 全部通过；跨端 11 字段逐字一致；7 项 Rust 不变量独立复算全绿；基线 157 断言零改动；懒加载边界未破；全套门禁绿。

修法约 1 行 + 1 断言（注意保留 B2 基准行），修完重跑 `npm test` + `cargo test` 即可复验。D-2/D-3 建议本轮一并修或明确延后（均非阻断）；D-4/D-5 记入观察项。

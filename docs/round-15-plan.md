# R15 本地用量历史 + 深度分析 — 执行规格

目标：让**所有**账号随时间积累出趋势（不再只有 sub2api/ModelServer 有图），并回答「和上周比怎样 / 钱花在哪个模型 / 哪个账号效率最差 / 哪天异常」。

## 0. 现状事实（侦察结论，实现前必读）

- 仅 `sub2api.rs` L101/L118 与 `modelserver.rs` L296/L325 产出 `dailyUsage`/`modelUsage`；`oneapi.rs` L110-111 显式置空 → DeepSeek/Kimi/OpenAI/智谱/百炼/one-api/自定义**无站点历史**。
- `history.json` 只存余额快照（上限 2000 条，余额不变不追加）；`results.json` 存最近一次 `RefreshOutcome[]`（整体覆盖）。
- `balance` 多数 provider 有（official.rs L394/L445、oneapi.rs L94、sub2api.rs L427、custom.rs L67）；`used` 计数器部分有（official.rs L451/L580、oneapi.rs L98/L204、custom.rs L68）；账号级累计 `requests` 基本为 null。
- `GlobalDailyUsageChart.tsx` L174-181 已有「费用模式只画主币种、其余脚注说明」先例，本轮沿用「不跨币种合并」；全仓无任何 usage-history 实现。

## 1. `usage-history.json` 数据契约

### 1.1 文件与记录（serde camelCase；TS 侧同名 interface）

```
UsageHistoryFile { version: u32, records: UsageRecord[] }        // 版本封套，便于迁移（不用裸数组）
UsageRecord { accountId: string, date: string("YYYY-MM-DD" 本地日历日), cost: f64|null, currency: string,
              requests: number|null, inputTokens: number|null, outputTokens: number|null, tokens: number|null,
              usedTotal: number|null, source: "site"|"local", updatedAt: string(now_iso() 本地 RFC3339) }
```
- `currency` 为归一币种（USD/CNY/CREDITS/UNKNOWN…），永不空串；`usedTotal` 仅供 §1.2 B2 使用，其余为 null。
- `totalTokens(r) = r.tokens ?? ((r.inputTokens ?? 0) + (r.outputTokens ?? 0))`，两者都缺 → `null`（与 `reportCsv.ts#tokenCell` 同口径）。

### 1.2 写入时机与计算规则（刷新成功后，由前端纯函数 `src/usageHistory.ts` 生成批次）

时机：`refresh_all` 成功后 → 生成批次 → `upsert_usage_history` → 重新 `get_usage_history`。

- **A 站点行（权威）**：对每个 `outcome.info.dailyUsage[].date` 产出一行；`cost=p.cost ?? null`；`currency = 归一(p.costUnit)`，非法币代码（如 `%`）回退该账号 `balance.currency` 归一、再回退 `"UNKNOWN"`；`requests/inputTokens/outputTokens/tokens` 取同名字段；`source="site"`。
- **B1 本地行（余额下降法）**：账号 `balance != null` 时，取该账号 `history.json` 快照按 ts 升序，每对**相邻且同归一币种**快照取 `drop = max(0, bal[i-1] − bal[i])`，计入 `localDate(s[i].ts)`；该日行 `cost = Σ drop`（**整日重算**，天然幂等）、`currency` 取该币种、`requests/tokens/usedTotal = null`、`source="local"`；首条快照不产出行。**跨日归属**：昨日末笔→今日首笔的下降额计入**今日**。
- **B2 本地行（used 计数器法，仅当 `balance == null` 且 `used != null`，如 Kimi 订阅）**：`delta = max(0, usedNow − usedTotalRow)`，`usedTotalRow` 取该账号最近一条 `usedTotal != null` 记录（无则首次观察、`delta = 0`）；`cost = (同日已有 local 行 cost ?? 0) + delta`；写回 `usedTotal = usedNow`；`currency = 归一(used.currency)`；重复刷新同一状态 `delta = 0` → 幂等。

### 1.3 合并优先级与幂等（Rust 侧 upsert，唯一合并点）

- 键 = `(accountId, date)`；`site` **覆盖** `local`，`local` **永不覆盖** `site`；同 source 同键 → 新批次覆盖旧值（同一天多次刷新只留最新）。站点窗口后移补齐历史日后自动完成 local→site 升级。
- 幂等：同一批次重复 upsert → 内容全等则**不写盘**（文件字节与 mtime 不变），返回总条数不变。

### 1.4 上限与清理

`MAX_USAGE_DAYS_PER_ACCOUNT = 400`；`MAX_USAGE_RECORDS = 20000`。每次 upsert 后：①每账号按 `date` 降序保留最近 400 天；②总量 > 20000 时按 `(date, accountId)` 升序丢最旧至 ≤ 20000。

### 1.5 降级（**读路径不动文件；写路径自愈前必须留痕**）

- 文件缺失 → `{version:1, records:[]}`（首次启动）。
- **读路径**：损坏 → `get_usage_history` 返回 `Err("用量历史文件格式错误: …")`，**不移动、不改写**原文件；前端按空处理 + 非阻塞提示，分析视图走占位（AC-1）。
- **写路径（自愈）**：upsert 读到损坏文件时，**先把损坏文件重命名为 `usage-history.corrupt-<unix秒>.json`**，再用本批记录重建；备份文件名必须出现在返回信息/日志中。理由：自愈是唯一会覆盖旧数据的路径，必须留痕，用户历史不得被静默丢弃（Lead 裁决 2026-10-15）。
- 版本未知（`version > 1`）→ 读取返回 Err 且**不覆盖**原文件（保护未来版本数据）。

### 1.6 credits 记录策略

记录且 `currency` 保留原值（`CREDITS`）；前端在所有法币口径（花费/周期/效率/异常日/模型排行）通过 `shouldSkipCurrency` 排除（§3）。

## 2. 三文件职责边界 + 新 IPC

| 文件 | 内容 | 写入者 | 生命周期 |
|---|---|---|---|
| `config.json` | 账号与设置 | 前端 save_config | 用户数据，损坏须报错 |
| `results.json` | 最近一次刷新结果（含 `dailyUsage`/`modelUsage` 原始点） | `refresh_all` 整体覆盖 | 模型维度**唯一**来源 |
| `history.json` | 余额快照序列（趋势图/差分基准） | `refresh_all` 追加 | 滚动 2000 条 |
| `usage-history.json` | **逐日**用量总账（仅账号×日期，无模型维度） | 前端算批次 → `upsert_usage_history` | 滚动清理，损坏写路径先备份再自愈 |

新 IPC（注册进 `lib.rs` invoke handler，与 `export_csv` 同款风格）：
- `get_usage_history(app) -> Result<UsageHistoryFile, String>`
- `upsert_usage_history(app, records: Vec<UsageRecord>) -> Result<usize, String>`（返回合并清理后**总条数**；需要合并结果时调用方再 `get_usage_history` 一次）
- 新增 `config.rs::usage_history_file_path` + `load_usage_history` / `upsert_usage_history`（原子写 = 临时文件 + rename，沿用 `save_history` 模式）；常量见 §1.4。

## 3. 分析指标公式（前端纯函数 `src/analysis.ts`，全部可单测）

统一输入 `records`（§1 合并后按启用账号过滤）。`today` = 本地日历日；窗口一律按**本地日历日**（时区无关，AC-14）。

### 3.1 周期对比（近 7 天 vs 前 7 天）
- `this = [today−6, today]`，`prev = [today−13, today−7]`；花费**按币种分别**算（`cost=null` 按 0 计，credits 排除）。
- `delta = costThis − costPrev`；`deltaPct = costPrev > 0 ? delta / costPrev × 100 : null`。
- 降级：`costPrev = 0 且 costThis > 0` → `deltaPct = null` 且标签「新增」；两者皆 0 → 「—」。
- 均值 `日均 = 窗口花费合计 / 7`（**固定分母 7**，含无记录日，保证两周可比）；请求数跨币种合计（计数无币种语义），`deltaPct` 同法。

### 3.2 模型成本排行
- 数据源：**`results.json` 的 `AccountInfo.modelUsage`**（本地总账不含模型维度），跨账号合并。
- 合并键 `m.model.trim().toLowerCase()`（显示名取首次出现原拼写）；`costUnit` 归一后**按币种分组成榜**。
- 排序：`cost` 降序 → `totalTokens` 降序 → 名称升序；取 **Top 5**。
- 降级：`cost == null` 的条目不进成本榜，另列「无成本数据」小榜（按 `totalTokens` 降序，Top 5）；整榜无数据 → 占位。

### 3.3 账号效率对比
- `costPerRequest = 窗口花费 / 窗口请求数`；`requestsPerUnit = 窗口请求数 / 窗口花费`（同账号同币种窗口内先聚合）。
- **跨币种绝不合并**：按 `currency` 分组成榜，币种间不比较、不相加；credits 单独成组。
- 除零：`requests = 0 或 null` → `costPerRequest = null`；`cost = 0 或 null` → `requestsPerUnit = null`。
- 「效率最差」：同币种内 `costPerRequest` 最大且窗口请求数 `≥ MIN_EFFICIENCY_REQUESTS(=10)` 者标红；无合格者不标。

### 3.4 异常日检测
- 序列：某 `(账号, 币种)` 近 `ANOMALY_WINDOW_DAYS(=14)` 天内的逐日 `cost`（缺失日不计入）。
- `med = median(有记录日 cost)`（偶数个取中间两值平均）；触发 `cost(d) > med × K`，`K = 2.5`。
- 最少样本：有记录日数 `≥ 5` 且 `med > 0`，否则「样本不足」不判定。
- 输出：按 `cost` 降序最多 3 条，标注账号/日期/金额/倍数（`cost / med`，1 位小数）。

### 3.5 数据来源优先级（冲突时的唯一裁决）
1. 逐日总账：**站点行 > 本地行**（§1.3），本地只补站点未覆盖的日期。
2. 模型维度：**只有** `results.json#modelUsage`。
3. 周期/效率/异常日：**只用** usage-history（不回退站点 `dailyUsage`，避免两处口径漂移）。
4. usage-history 为空 → 分析视图显示占位，**不**回退 `results.json`（AC-1：避免"看着有数据其实只有一天"的误导）。

## 4. 验收标准（逐条可测；每条已对照 § 规则自查，见 §6）

- AC-1 无 `usage-history.json` 或 records 为空：分析视图不崩，显示「暂无本地用量历史」占位（§1.5/§3.5.4）。
- AC-2 同日两次刷新 `balance 100→80`：产生 1 条该日行，`cost=20`、`currency` 正确、`source="local"`（§1.2 B1）。
- AC-3 幂等：同日 `100→80→70` → 仅 1 行且 `cost=30`（整日重算非累加）；**同批次 upsert 两次，文件字节不变**、总条数不变（§1.2 B1/§1.3）。
- AC-4 站点优先：站点该日 `cost=5`、本地估算同日 drop=20 → 结果 `cost=5, source="site"`；站点窗口后移覆盖曾被 local 占用的日期 → 升级为 site（§1.3）。
- AC-5 充值免疫：同日 `100→50→80→40` → 本地 `cost = 50 + 40 = 90`（§1.2 B1）。
- AC-6 跨日归属：昨日末笔 100 → 今日首笔 70 → 差额 30 记入**今日**（§1.2 B1）。
- AC-7 上限清理：单账号 401 天 → 仅最近 400 天保留（最旧 1 天消失、最新仍在）；总条数 20001 → 清理后 20000 且丢最旧（§1.4）。
- AC-8 损坏：**读路径**返回可读中文 Err 且原文件未被移动/改写；**写路径**先产生 `usage-history.corrupt-<unix秒>.json` 备份（返回信息含该名）再用本批重建，旧内容可从备份找回（§1.5）。
  - **口径澄清（2026-10-15，裁决人 Lead）**：上述「返回信息含该名」落定为——读路径 Err 文本含**文件路径**且不动文件；写路径自愈前先备份、**备份文件名进日志**（成功路径签名保持 `Result<usize, String>`，该类型没有携带文本的位置）；**备份失败则拒绝写入并 Err**（宁可本次不写，也不覆盖未留痕的旧数据）。
- AC-9 credits：Kimi 账号产生 `currency="CREDITS"` 行（B2：首次刷新 `delta=0` 不产生花费行，used 增长后产生）；该行不出现在花费/周期/效率/异常日的法币聚合（§1.6/§3）。
  - **口径澄清（2026-10-15，裁决人 Lead）**：「首次刷新 `delta=0` 不产生花费行」落定为——**首次观察仍写一条基准行（`cost=0`、`usedTotal=usedNow`），只是不产生花费**。不落基准行则下次永远算不出 `delta`，B2（`balance=null` 的 Kimi 订阅）路径会彻底失效；该基准行 `cost=0`，不影响任何费用聚合。
- AC-10 周期数值：USD 近 7 天 70、前 7 天 50 → `delta=+20`、`deltaPct=+40.0%`、日均 `10.00` vs `7.14`；前 7 天 0 而本周 20 → `deltaPct=null` 且「新增」（§3.1）。
- AC-11 模型排行数值：同名模型 A 两账号 `5 + 7.5 = 12.5`、B `8` → 榜序 `A > B`；`costUnit` 不同 → 分成两榜不合并（§3.2）。
- AC-12 效率数值：X 花费 30 USD/请求 300 → `0.1 USD/请求`；Y 20/100 → `0.2` → 最差为 Y；请求 0 的账号 `costPerRequest=null` 不参与排名；USD 与 CNY 分列两榜（§3.3）。
- AC-13 异常日数值：近 14 天 `13×10 + 1×40` → `med=10`、阈值 `25` → 40 判为异常日（倍数 `4.0×`）；仅 3 天有记录 → 「样本不足」不判定（§3.4）。
- AC-14 时区无关：同一份 records 在 `TZ=UTC` 与 `TZ=Asia/Shanghai` 下周期窗口、日期键、异常日结果一致（§3 开头）。
- AC-15 IPC 契约：`get_usage_history` 返回 `{version, records}`；`upsert_usage_history(records)` 返回合并清理后总条数；旧 `config.json`（无 R15 字段）加载不受影响（§2）。
- AC-16 职责边界：一次刷新后 `usage-history.json` 不含模型维度、`history.json` 不含花费、`results.json` 仍是最近一次结果整体覆盖（§2 表）。

## 5. 明确不做的事

- 不做云同步/多设备合并；不做汇率换算或任何跨币种合计（USD 与 CNY 永不相加）。
- 不做 PDF/Excel 导出（CSV 已在 R14 交付）；不新增 `NotificationKind`、不动通知阈值体系。
- 不改 `BalanceSnapshot` 与 `history.json` 格式、不改 `append_history` 去重逻辑；不做站点缺失历史的回填（本地只从现在开始积累，不伪造过去）。
- 不做 model 维度的本地持久化；不做分析窗口/上限/K 值的用户可配 UI（本轮为常量）；不做异常日的季节性/机器学习检测。

## 6. 自查记录（Lead 要求的两条经验教训）

**公式自洽验算（全部手算复核）**：B1 `100→50→80→40` → `50+0+40=90` ✔（AC-5）；`100→80→70` → `20+10=30` ✔（AC-3）；周期 `(70−50)/50×100 = +40.0%` ✔、`70/7=10.00`、`50/7=7.142857→7.14` ✔（AC-10）；效率 `30/300=0.1`、`20/100=0.2` ✔（AC-12）；异常日 14 值中间两值均为 10 → `med=10`，`10×2.5=25 < 40` ✔（AC-13）；模型 `5+7.5=12.5 > 8` ✔（AC-11）。

**AC ↔ § 对照**：AC-1→§1.5/§3.5.4、AC-2→§1.2B1、AC-3→§1.2B1/§1.3、AC-4→§1.3、AC-5→§1.2B1、AC-6→§1.2B1、AC-7→§1.4、AC-8→§1.5、AC-9→§1.6/§3、AC-10→§3.1、AC-11→§3.2、AC-12→§3.3、AC-13→§3.4、AC-14→§3 开头、AC-15→§2、AC-16→§2 表。无孤儿 AC，无与 § 冲突的 AC。

## 7. 变更历史

| 日期 | 变更 | 裁决人 | 说明 |
|---|---|---|---|
| 2026-10-15 | §1.5 数据安全修正 | Lead | 损坏**写路径**自愈前必须先备份为 `usage-history.corrupt-<unix秒>.json` 并在返回/日志带备份名；读路径保持「报错、不动文件」。自愈是唯一覆盖旧数据的路径，不得静默丢用户历史 |
| 2026-10-15 | 临时冻结契约作废 | Lead | 阻塞期间下发给开发 B 的「裸数组 + 单 IPC + 180 天/账号」临时契约**作废**；以本文件 §1/§2 为唯一权威（版本封套、`source` 语义、两个 IPC、400/20000 回收、写自愈） |
| 2026-10-15 | AC-8 / AC-9 口径澄清 | Lead | 保留 AC 原文另加澄清（不静默改写）：AC-8 备份名进日志、备份失败拒绝写入、签名保持 `Result<usize, String>`；AC-9 首次观察写 `cost=0` 基准行（带 `usedTotal`）以保住 B2 增量。落笔见 §4 对应条目 |

## 附：建议分工

- 开发 A（前端）：`src/usageHistory.ts`（批次生成 A/B1/B2）、`src/analysis.ts`（§3 四个指标）、分析视图与 Dashboard 接线。
- 开发 B（Rust）：`UsageRecord`/`UsageHistoryFile` 类型、`config.rs` 路径与 load/upsert（原子写+清理+先备份再自愈）、两个 IPC 注册与单测。
- 美工：分析视图视觉（周期卡、排行条、异常日标记），沿用现有语义色与 `src/components/ui/` 原语。

# R14 数据洞察与预警 — 执行规格

目标：看板从「显示当前数字」升级为「告诉我正在发生什么、接下来会怎样」。

## 0. 现状事实（实现前必读）

- 阈值硬编码于 `src/notifications.ts` L48-52：`{ lowBalanceUsd: 1, lowBalanceCny: 7, quotaPercent: 85 }`；`App.tsx` L368 直接传 `DEFAULT_NOTIFY_THRESHOLDS`。
- `BalanceSnapshot { ts, accountId, balance, currency }`（`types.rs` L245-253），存 `history.json`，上限 2000 条，余额不变不追加（`config.rs` L56-74）。
- `UsagePoint` 已含 `date/requests/tokens/cost/costUnit`（`types.rs` L179-195），挂在 `AccountInfo.dailyUsage`，持久化在 `results.json`（每次刷新整体覆盖）。
- credits 跳过集 `SKIP_CURRENCIES = {CREDITS, CREDIT}`；CNY 集 `{CNY, RMB, CNH}`（`notifications.ts` L55-58），本轮沿用。
- 导出链路已有先例：前端 `save()` 对话框选路径 → `invoke("export_config", { path })`（`api.ts` L42-52）。

## 1. 洞察指标定义（前端新纯函数模块 `src/insights.ts`，全部可单测）

分组键：`(accountId, currency)`，currency 先 `toUpperCase()` 归一；命中 SKIP_CURRENCIES 的组不参与本节任何指标。
统计范围：`outcomes` 中 `ok=false` 的账号不产生洞察、也不参与「消耗最快」（AC-5 按原文执行）；调用方只传快照、未提供 `outcomes` 时无失败信息，全部参与。

### 1.1 日均消耗 burnRate（单位：币种/天）
- 窗口：取 `ts ≥ now − insightWindowDays 天` 的快照（默认 14 天，见 §3），按 ts 升序。
- 算法（充值免疫）：`totalDrop = Σ max(0, b[i-1] − b[i])`（逐对差分，只累计下降段）；`spanDays = (last.ts − first.ts) / 86400s`。
- `burnRate = totalDrop / spanDays`。
- 降级（返回 `null`，UI 显示「—」）：窗口内快照 < 2 条；或 `spanDays < 0.5`（12 小时）；或 `totalDrop ≤ 0`。
- 例：100→50→80（充值）→40，跨度 2 天 → totalDrop=50+40=90，burnRate=45/天（不是 (100−40)/2=30）。

### 1.2 余额可支撑天数 daysLeft
- `daysLeft = 当前余额 / burnRate`；当前余额 = 该组最新快照 `balance`。
- burnRate 为 null → 显示「—」。显示规则：< 1 →「< 1 天」；1–10 → 1 位小数；≥ 10 → 四舍五入整数 +「天」。

### 1.3 本月预计支出 projectedMonthSpend（按币种分别出数）
- `monthDrop`：当月 1 日 00:00（本地时区）起窗口内快照的同法 totalDrop（只在当月快照间两两差分，不跨月边界；当月仅 1 条快照 → monthDrop=0）。
- `remainingDays = 当月总天数 − 今天日期数`（今天已发生消耗已含在 monthDrop，今天剩余时间不预测，口径偏保守）。
- `projected = monthDrop + burnRate × remainingDays`（burnRate 取 §1.1 的账户级速率，同币种账号求和）；按 currency 汇总展示（USD、CNY 各一行，不跨币种合计）。
  - **裁决（2026-10-15，裁决人 Lead）**：以本行口径为准，与 §5 AC-11 的 `30 + 2.143×15 ≈ 62.1`（精确值 `30 + (30/14)×15 = 62.142857…`）一致。开发 A 曾实现为「月内速率 + 31 天月的剩余 16 天」得 ≈64.29，并据此改写本节——属误读 AC-11（该 AC 从未要求 64.29），已裁定回退；终审独立复算当前实现得 `62.14285714285714`，与本节一致。本条由实现方在实现期间写入，规格作者（pm-lead）2026-10-15 复核后追认（对应终审 D-5）。
  - 退化规则：某币种内 burnRate 全为 null 且 monthDrop = 0 → 该币种跳过；burnRate 全为 null 但 monthDrop > 0 → 只展示已发生额并标 `degraded`，不外推。
  - §1.1 的跨度度量采用「本地日历天 + 日内占比」而非纯毫秒差（夏令时切换当天会差 1 小时；规格作者复核：America/New_York 跨 2026-11-01 回拨的两天纯毫秒差为 2.0417 天、跨 2026-03-08 前拨为 1.9583 天，而本地日历天均为 2 天）——这是对 §1.1 的实现细化，不改变口径。

### 1.4 消耗最快账号（「注意」摘要）
- 每个币种内取 burnRate 最大且非 null 的 (账号, 币种) 组，各币种至多一名。
- 仅展示在洞察区摘要条，不进通知中心、不新增 NotificationKind。文案：`「{账号名}」消耗最快：{burnRate} {币种}/天，余额约可支撑 {daysLeft} 天`。
- daysLeft ≤ 7 时摘要条用 `--warn` 语义色；≤ 3 用 `--err`；否则普通信息色。

## 2. 数据契约变更（前后端字段名以此为准）

- **BalanceSnapshot 不改**：§1 全部指标可从现有 4 字段推导，history.json 格式、去重逻辑、MAX_HISTORY 均不动。
- **Settings 新增 5 个可选字段**（`types.rs` Settings，沿用 `Option<T>` + serde default 模式，旧 config.json 无这些字段也能加载）：

  | Rust 字段（snake_case） | TS 字段（camelCase） | 类型 | None 时默认 |
  |---|---|---|---|
  | `notify_enabled` | `notifyEnabled` | `Option<bool>` | `true` |
  | `notify_low_balance_usd` | `notifyLowBalanceUsd` | `Option<f64>` | `1` |
  | `notify_low_balance_cny` | `notifyLowBalanceCny` | `Option<f64>` | `7` |
  | `notify_quota_percent` | `notifyQuotaPercent` | `Option<f64>` | `85` |
  | `insight_window_days` | `insightWindowDays` | `Option<u32>` | `14` |

- **新 IPC**：`export_csv(path: String, content: String) -> Result<(), String>`（Rust 侧原子写，同 `save_results` 模式；BOM 由前端写进 content，Rust 不加工）。
- 前端派生：`App.tsx` L368 改为从 `config.settings` 派生 `NotifyThresholds`（`?? DEFAULT_NOTIFY_THRESHOLDS.xxx`），useMemo 依赖 config；`notifyEnabled=false` 时调用方丢弃 `lowBalance/quotaFull` 两类通知及其 problemKeys（refreshError 不受开关影响，失败是事实不是提醒）。

## 3. 告警阈值设置项（设置面板新增「提醒与洞察」分组）

| 设置键 | UI 标签 | 默认 | 校验（保存时拒绝越界并提示） |
|---|---|---|---|
| `notifyEnabled` | 启用余额/配额提醒 | 开 | — |
| `notifyLowBalanceUsd` | 低余额提醒阈值（USD 及其他法币） | 1 | 0 ≤ x ≤ 10000 |
| `notifyLowBalanceCny` | 低余额提醒阈值（CNY） | 7 | 0 ≤ x ≤ 100000 |
| `notifyQuotaPercent` | 配额用量提醒线（%） | 85 | 1–100 整数 |
| `insightWindowDays` | 洞察统计窗口（天） | 14 | 3–90 整数 |

credits 跳过、CNY 币种集保持硬编码（是语义不是阈值）。阈值改动保存后下一轮通知计算即生效，无需重启。

## 4. 报表导出 CSV（前端新模块 `src/reportCsv.ts`，纯函数 `buildUsageCsv(rows): string`）

- 列（表头中文、顺序固定）：`账号名称, 账号类型, 币种, 日期, 当日花费, 当日请求数, 当日Token, 当日余额快照`。
- 行集合：**仅法币账号** × `union(dailyUsage[].date, 该账号 history 快照的本地日期)`，日期升序；`账号类型` 取 `PROVIDER_KINDS` label。**排除规则**：先按下一行「币种」取值规则算出该账号的报表币种，归一后命中 `SKIP_CURRENCIES`（`CREDITS`/`CREDIT`）则整账号不产出任何行。理由：credits 是点数/订阅单位而非法币，与「余额/花费」口径不可比；且必须与洞察侧 `shouldSkipCurrency` 判定一致（§5 AC-4）。
- 列取值：`当日花费/请求/Token` 取自 dailyUsage 同 date 行（无则空字符串）；币种优先 `costUnit`，否则该组快照 currency；`当日余额快照` = 该账号该本地日 ts 最大一条快照的 balance（无则空）。
- 编码：内容首字符 `\uFEFF`（UTF-8 BOM，Excel 中文兼容）；字段转义按 RFC 4180（含 `,` `"` 换行 的字段双引号包裹、内部 `"` 双写）；行尾 `\r\n`。
- 数字：`String(number)` 原始最短十进制，不千分位、不补零；空值一律空字符串（禁止出现 `undefined`/`null`/`NaN`）。
- 入口：看板工具栏「导出 CSV」；`save()` 对话框 defaultPath `llm-usage-YYYY-MM-DD.csv`，filters csv；取消静默返回。
- **变更记录（2026-10-15，裁决人 Lead）**：行集合原写「每个启用账号」，与 §5 AC-4「credits 不出现在 CSV 行」矛盾；现统一为「CSV 排除 credits/CREDIT 行」（AC-4 原文优先，判定复用洞察侧 `shouldSkipCurrency`）。同日确认 §5 AC-5 口径为「刷新失败账号不产生洞察、不上消耗最快」按原文执行。详见 §7。

## 5. 验收标准（逐条可测）

- AC-1 history.json 为空/不存在：洞察区不崩，每项显示「—」与占位文案「暂无历史数据」。
- AC-2 单账号仅 1 条快照：burnRate/daysLeft 显示「—」，页面无 Infinity/NaN。
- AC-3 充值用例 100→50→80→40（跨度 2 天）：burnRate=45/天，不出现负值。
- AC-4 credits 币种账号（Kimi 订阅）不出现在任何洞察指标与 CSV 行中。
- AC-5 刷新失败账号不产生洞察，且不影响其他账号的计算。
- AC-6 阈值 USD 1→10 保存后，下一次刷新中余额 5 的账号立即产生「余额不足」；恢复通知 diff 同样按新阈值。
- AC-7 `notifyEnabled=false`：lowBalance/quotaFull 不再产生，refreshError 仍产生；已有低余额通知在下次刷新后消失。
- AC-8 旧 config.json（无新字段）加载不报错、按默认阈值工作；保存后新字段落盘（`load_from_path` 往返一致）。
- AC-9 越界阈值（如 quotaPercent=120）保存被拒绝并有可读提示。
- AC-10 CSV：Excel 打开中文不乱码；账号名含逗号时列不错位；列序与 §4 一致；无 dailyUsage 的账号花费/请求/Token 为空串。
- AC-11 预测公式用例：当月 1 日 100 → 15 日 70（当月 30 天）：monthDrop=30、burnRate=30/14≈2.143、projected=30+2.143×15≈62.1。
- AC-12 同币种 3 账号时摘要条选中 burnRate 最大者；其 daysLeft ≤ 7 时摘要条呈 warn 色。

## 6. 明确不做的事

- 不做长期逐日用量持久化（不新建 usage-history.json；CSV 用 results.json 现有 dailyUsage 窗口）。
- 不做汇率换算、不做跨币种合计（USD 与 CNY 永不相加）。
- 不做系统通知/邮件/Webhook 告警，不新增 NotificationKind（最快账号只上洞察区摘要条）。
- 不动 `append_history` 去重逻辑与 MAX_HISTORY=2000；BalanceSnapshot 不加字段。
- 不做按账号独立阈值（仅全局）；不做按模型维度的花费洞察。
- 不做洞察区以外的大改版（布局由美工按现有设计系统落位）。

## 7. 变更历史

| 日期 | 变更 | 裁决人 | 说明 |
|---|---|---|---|
| 2026-10-15 | §1.3 投影口径回退 | Lead | `projected = monthDrop + burnRate × remainingDays`；AC-11 = `30 + (30/14)×15 = 62.142857…`（≈62.1）。曾误按 31 天月得 ≈64.29，已回退；终审独立复算当前实现得 62.14285714285714 |
| 2026-10-15 | §4 与 AC-4 口径统一 | Lead | CSV 排除 `credits`/`CREDIT` 行；§4 原「每个启用账号」与 AC-4 的矛盾已消除（判定复用 `shouldSkipCurrency`） |
| 2026-10-15 | §1.1 跨度度量细化 | Lead | 改用「本地日历天 + 日内占比」，规避夏令时毫秒差误差（口径不变）；原有示例数值不准，规格作者已按实测订正 |
| 2026-10-15 | §5 AC-5 口径确认 | Lead | 按原文执行：刷新失败账号不产生洞察、不上「消耗最快」；§1 补「统计范围」一行落实该口径 |
| 2026-10-15 | 规格订正追认 | pm-lead | §1.3 裁决记录与 §1.1 细化系实现方在实现期间写入（终审 D-5）；规格作者复核后追认，并把上列变更落笔归档；AC-4/AC-5 原文即约束，不改写 AC 文字 |

## 附：建议分工

- 开发 A：`src/insights.ts`、`src/reportCsv.ts`（纯函数+单测）、App.tsx 阈值派生接线、设置面板分组、洞察区组件。
- 开发 B：Settings 5 字段（含默认与往返测试）、`export_csv` 命令（原子写）。
- 美工：洞察区与「注意」摘要条视觉（沿用现有语义色与卡片原语）。

# R19 主指标「订阅优先」+ 详情页空数据区块默认折叠 — 执行规格

## 0. 事实基础（Lead 真实数据侦察，不再推断）

- **ModelServer**：`balance={amount:0,currency:USD}`、`quotaWindows=[{window:"7d",usedPercent:0,resetsAt:"2026-10-23T04:11:36Z"}]`、`extras` 8 项、`dailyUsage` 29 / `modelUsage` 27 条；`raw` 有 `balance_credits`（当前 0）、`max_topup/min_topup`（充值上下限，**非余额**）。**面板无独立「加油包」字段**（开发 B 复核中）。
- **Kimi**：`balance=null` + 两窗口（5h 26.86%、7d 12.36%）→ 已是百分比优先。
- **现状**：`ProviderCard.tsx` L126-133/L172-183「只要有 `info.balance` 就显示余额为主指标」→ ModelServer 主指标显示 **$0**；`quotaWindows` 只在次级 `QuotaWindowBars`（L204）。
- **详情抽屉**：内容在 `ProviderCard` 内 —— `DailyUsageChart`(L316)、`ModelUsageChart`(L319)、`TokenSplitChart`(L322)、`BalanceTrendChart`(L325)、附加信息列表（>6 行才折叠，L229-236）、原始数据（**已默认收起**，L336-345）。各图表已支持 `emptyNote` 空态文案（占大块空白 → 本轮改折叠）。

## 1. 卡片主指标规则（**通用纯函数**，不打供应商补丁）

新增纯函数 `pickPrimaryMetric(info) -> {kind:"quota"|"balance"|"none", ...}`，判定顺序：

1. `info == null` → `kind="none"`（主指标「—」，卡片结构不变）。
2. **`kind="quota"` 条件**：有效窗口数 ≥1 **且**（`balance == null` **或** `balance.amount === 0`）→ 主指标 = **订阅剩余百分比**：
   - 取**最紧窗口** = `usedPercent` 最大者（越界钳制见 §1.3）；显示 `剩余 = 100 − usedPercent`（**最多 2 位小数、去尾 0**，见 §5 口径澄清①），窗口名（如 `7d`）+ **重置倒计时**（复用现有相对时间/倒计时格式，`<1h` 显示「N 分钟后重置」）。
   - 视觉语言与 Kimi 一致（同一套百分比主样式，非新增样式族）。
3. **`kind="balance"`**：其余情况 → 主指标 = 余额（**维持现状**，含无窗口且余额为 0 的付款制账号：$0.00 是真实信息，不算误导）。
4. `kind="none"`（余额为 null 且无有效窗口）→ 主指标「—」。
5. **降级细则**：`quotaWindows` 为 `[]`/`null` → 视为无窗口；`usedPercent` 为 `null`/`NaN` → **忽略该窗口**；忽略后无窗口 → 走余额分支；窗口名 `null`/空串 → 显示「当前窗口」。
6. **越界钳制**：`usedPercent < 0 → 视作 0`（剩余 100%）；`> 100 → 视作 100`（剩余 0%）；**不做负数/超 100 的原始值展示**。

**剩余百分比公式（供 AC 笔算）**：`remain = round2(clamp(100 − clamp(used,0,100), 0, 100))`，**展示去尾 0、最多 2 位小数**（见 §5 口径澄清①）。
Kimi 最紧 = 26.86 → 剩余 **73.14%**；ModelServer 7d = 0 → 剩余 **100%**。

## 2. 次级显示规则（不显示误导性「$0」）

- **主指标为 quota 时**：
  - `balance != null && balance.amount > 0` → 次级行显示**充值/钱包余额**（`$12.50` 样式不变）。
  - `balance == null` 或 `amount == 0` → **不渲染余额行**（禁止出现「余额 $0」这类主/次误导项）。
  - 若 `raw.balance_credits > 0` → 次级行显示 **「充值余额 N」**（单位取 `raw` 的 credit 语义，如 `credits`）。
- **标签口径裁定：用「充值余额」，不用「加油包」**。理由：面板**无独立「加油包/附加包」字段**，`balance_credits` 是钱包充值口径额度，`max_topup/min_topup` 是充值上下限而非余额 —— 标成「加油包」会在数据上撒谎。**若开发 B 复核发现面板确有独立附加包字段**，则改为该字段单独成行并保留「充值余额」行，二者互不替代（此情形需在终审前回传证据）。
- `raw` 里的原始字段照旧在「原始数据」里可见（口径不被隐藏，只是不当主指标）。

## 3. 详情页「无数据项默认折叠」

- **新增维度级 `hasData` 纯函数**（各维度独立判定）：
  - `daily`：`dailyUsage` 中存在 ≥1 个「有效点」（`requests`/`tokens`/`inputTokens`/`outputTokens`/`cost` 任一非 `null`）。
  - `model`：`modelUsage` 中存在 ≥1 个有效点（同上）。
  - `token`：`modelUsage` 中存在 ≥1 个点的 token 字段非 `null`。
  - `balance`：该账号快照数 **≥ 2**（单点成不了趋势）；`=== 1` 视为无数据，折叠说明写「已有 1 个快照，再刷新一次即可成趋势」。
  - `extras`：沿用现有规则（>6 行才折叠），空 → 区块不渲染（现状）。
  - `raw`：沿用现状（默认收起，`raw != null` 才显示入口）。
- **折叠语义**：`hasData === false` 的区块**默认渲染为折叠态** —— 保留**区块标题**与**一行说明**（复用各图表现有 `emptyNote` 文案），点击标题展开；**不记忆**（纯默认态：重挂载/重开抽屉仍折叠，不写 localStorage）。
- **有数据区块维持现状**（默认展开、图表照常）。
- **无障碍**：折叠头为 `<button>`，带 `aria-expanded` + `aria-controls`（指向内容容器 id）；Enter/Space 可切换；折叠态内容不进入 Tab 序；焦点环沿用现有样式。

## 4. AC 清单（纯函数 / DOM 可验）

- **AC-1** ModelServer 实测数据（balance 0 + 7d 0%）→ `kind="quota"`、剩余 **100%**、窗口名 `7d`、含重置倒计时；卡片 DOM 不出现金额主指标。
- **AC-2** Kimi 数据（balance null + 26.86/12.36）→ `kind="quota"`、取**最紧**窗口、剩余 **73.14%**。
- **AC-3** 无窗口 + `balance=12.5` → `kind="balance"`、主指标 `$12.50`（现状不变）；无窗口 + `amount=0` → 仍 `kind="balance"`（$0.00 属真实信息）。
- **AC-4** 次级不误导（DOM）：`kind="quota"` 且 `balance.amount===0` → 卡片内**无** `$0` 文本；`balance.amount=12.5` → 出现余额行；`raw.balance_credits=50` → 出现「充值余额 50」。
- **AC-5** 降级与越界（纯函数）：`usedPercent=-5 → 100%`、`150 → 0%`、`null/NaN → 忽略`、全部忽略 → 走余额分支、窗口名 null → 「当前窗口」、`quotaWindows=[]` → 无窗口。
- **AC-6** `hasData` 判定（纯函数）：四维度各自空数组/全 null → `false`；含有效点 → `true`；快照数 1 → `false`、2 → `true`。
- **AC-7** 空区块默认折叠（DOM）：无数据区块 `aria-expanded="false"`，内容容器 `hidden`/未挂载，**标题与一行说明可读到**（如「暂无每日用量数据 · 刷新后自动积累」）。
- **AC-8** 有数据区块默认展开（DOM）：`aria-expanded="true"` 且内容在 DOM。
- **AC-9** 空区块可展开 + 键盘：点击折叠头 → 展开并显示原空态文案；Enter/Space 同样可切；折叠态内容不在 Tab 序。
- **AC-10** 不记忆：展开一个空区块后重挂载抽屉 → 仍为默认折叠；`localStorage` 无相关新键。
- **AC-11** 既有折叠不回归：附加信息 >6 行折叠（L229-236）与「原始数据」默认收起行为不变。
- **AC-12** 无回归：`npx tsc --noEmit`、`npm test`（本机 + TZ=UTC）、`cargo test` 全绿；R14–R18 断言与口径未被改动（对照 HEAD 核删除/改动数）。

## 5. 自查与不做

**AC→§**：AC-1/2/3/5→§1；AC-4→§2；AC-6/7/8/9/10/11→§3；AC-12→§0/§1。无孤儿 AC；AC-1/2/3/5 与 §1 判定顺序逐条对应（不存在「AC 说 quota 优先、§ 说 balance 优先」这类矛盾）。
**笔算**：`remain(clamp(100 − clamp(used,0,100),0,100))`：ModelServer `100−0=100`；Kimi `100−26.86=73.14`；`used=-5 → 100`；`used=150 → 0` ✔。
**明确不做**：不改后端数据口径与解析（`balance`/`quotaWindows`/`raw` 的产出规则一律不动，本轮只改「显示与呈现」）；不新增依赖；不改 R14–R18 的 AC/阈值/口径；不为供应商打分叉补丁（规则必须通用）；不做「加油包」标签（除非 §2 的复核证据出现）；不改主窗口其它区块与托盘浮层（R18）。

### 口径澄清（R19 终审裁定；AC 原文与 § 原文均保留）

① **剩余百分比精度**：§1.2 原文「保留 1 位小数」与 **AC-2（Kimi 显示 73.14）** 冲突。**裁定：以 AC-2 为准 —— 最多 2 位小数、去尾 0、整数不带小数。** 理由：① AC 是可判定验收项，2 位与同一卡片内 Kimi 既有窗口条 `26.86%/12.36%` 精度一致（同卡片两套精度反而更差）；② 去尾 0 已消除「100.0」这类噪声（实测 `trimNumberText(100)="100"`、`73.1="73.1"`）；③ 数值未被放大（`剩余 = 100 − 已用` 原值仅四舍五入到 2 位）。

② **§3 维度由 4 扩为 5**：原文只列 daily/model/token/balance；实现把「**额度构成**」纳入同一折叠语义。**裁定：接受**（§3 增列该维度：`hasBreakdownData` = `total.amount > 0` 且（`used` 或 `balance` 可得），或有有效配额窗口）。理由：① 用户原话是通用要求（「没有数据的项就可以默认折叠」），额度构成同属「项」；② 由**独立纯函数**承担且与其他四维互不继承（`drawerDataFlags` 五键各自判定）；③ 纯呈现改动、零数据口径改动；④ 实测 ModelServer（`total=0` + 有效窗口）→ `breakdown=true` 仍展开，行为合理。

③ **「充值余额」extra 改为条件产出**（task-42 小修；Lead 真机截图发现「充值余额 0.00 CNY」违背用户「如果有…再显示」）：**该 extra 仅在充值口径余额 > 0 时产出**（0/负数/NaN/∞/字段缺失 → 不产出、不给占位行），其它 extras 与 `balance` 语义不变。与 §2「次级行 `raw.balance_credits > 0` 才显示」**同判据**，故两端口径一致、不会重复展示（去重见 `ProviderCard.tsx:152/252`）。

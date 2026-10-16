# R19 终审 + 复验冻结（对照 `docs/round-19-plan.md` AC-1..AC-12）

方法：独立复算（esbuild 打包真实模块 → Node 探针对 `pickPrimaryMetric` / `drawerSections` 自备期望值）+ 源码结构核对 + 单次全套门禁 + 哈希夹逼。临时探针已删，**被审仓库零修改**。
**坦白一处限制**（延续 R17/R18）：Node 下 SSR 渲染探针受 React 双实例限制无法运行，故 DOM 类 AC（AC-4/7/8/9/10）为「**源码结构核对 + 仓库新增 DOM 用例**（`ProviderCard.test.tsx`，门禁中实跑）」双证，而非我自己的渲染证据。

## 1. 两处仲裁裁定（已落笔 plan §5「口径澄清」，AC/§ 原文均保留）

① **剩余百分比精度 = 以 AC-2 为准（最多 2 位、去尾 0、整数不带小数）**。理由：AC 是可判定验收项且 2 位与同一卡片内 Kimi 既有窗口条 `26.86%/12.36%` 精度一致（一张卡片两套精度更差）；去尾 0 已消除 `100.0` 噪声（实测 `trimNumberText(100)="100"`、`73.1="73.1"`）；数值未被放大（`100 − 已用` 仅四舍五入到 2 位）。§1.2 的「保留 1 位」判定为笔误。
② **§3 维度由 4 扩为 5（接受「额度构成」纳入折叠）**。理由：用户原话是通用要求（「没有数据的项就可以默认折叠」）；由独立纯函数 `hasBreakdownData` 承担、与四维互不继承；纯呈现、零口径改动；实测 ModelServer（`total=0` + 有效窗口）→ `breakdown=true` 仍展开，合理。

## 2. AC 判定

| AC | 判定 | 独立证据（探针实测） |
|---|---|---|
| AC-1 | 通过 | ModelServer 真实数据 → `kind=quota`、`remainingText="100"`、`windowLabel="7d"`、`resetsText="7天后重置"`；卡片结构上 quota 分支只渲染剩余文本（`ProviderCard.tsx:186-193`），**不存在 `$0` 主指标** |
| AC-2 | 通过 | Kimi 数据 → 取最紧窗口 `5h`、`remainingText="73.14"`、`remainingPercent=73.14`、`14小时后重置` |
| AC-3 | 通过 | 无窗口+12.5 → `balance/12.5`；无窗口+0 → **仍 `balance/0`**（$0.00 属真实信息）；`balance=null` 且无窗口 → `none`；有余额且有窗口 → `balance`（余额优先，与 §1 判定顺序一致） |
| AC-4 | 通过（结构级） | `readBalanceCredits`：`50`/`"50"` → 50，`0`/`-3`/缺失 → `null`；`ProviderCard.tsx:246` 余额行要求 `amount > 0`、`:252-254` 充值余额行仅 `credits !== null` 时渲染，且与后端 extras 同名行**去重**（`:151-152`）；仓库用例断言页面**不含「加油包」**字样 |
| AC-5 | 通过 | `-5 → "100"`、`150 → "0"`；`usedPercent=null` 的窗口被忽略（该账号回落 `balance`）；`NaN` 窗口被忽略但保留有效窗口（取 `5h`）；窗口名缺失 → `当前窗口`；`resetsAt` 缺失 → `null`、已过期 → `已到期`；`[]`/`undefined` → 无有效窗口 |
| AC-6 | 通过 | `drawerDataFlags` 五维独立：空数组全 `false`；全 `null` 点 → `false`；有效点 → `true`；**`balance` 快照 1 → `false`、2 → `true`**；只计本账号快照（`fOther.balance=false`）；`token` 需 token 字段（仅 requests 的模型点 → `token=false`）；`breakdown` 扩展维度 `false/true` 两态均正确 |
| AC-7 | 通过（结构级） | `DrawerSection.tsx:21` `useState(hasData)` → `hasData=false` 即**默认折叠**，`aria-expanded={open}`、`aria-controls={bodyId}`，且折叠头内渲染 `emptyNote`（`:34`）→ 标题与一行说明**可读**；内容仅在 `open` 时渲染 → 不挂载 |
| AC-8 | 通过（结构级） | `hasData=true` → `useState(true)` 默认展开、图表照常渲染 |
| AC-9 | 通过（结构级） | 折叠头是真实 `<button type="button">`（Enter/Space 原生可切）+ `aria-controls` 指向内容容器 id；折叠态内容不在 DOM ⇒ 不进 Tab 序 |
| AC-10 | 通过 | R19 四个源文件内 `localStorage` 仅出现 **1 次且为注释**（`DrawerSection.tsx:6`「不记忆（不写 localStorage）」）→ **零写点**；`useState` 初值不持久化，重挂载回到默认态 |
| AC-11 | 通过 | 附加信息 >6 行折叠（`aria-expanded={showAllExtras}`，`ProviderCard.tsx:282`）与「原始数据」默认收起（`:390`）均保持不变 |
| AC-12 | 通过 | `tsc` 0；`npm test` **399/399**（本机）与 **399/399**（TZ=UTC）；`cargo test` **87 passed / 0 failed**；clippy/fmt 0；`vite build` 成功、入口 `main-DKpkciYA.js` 146,918 B 且 `recharts` 命中 0；基线 276 条断言**删除/改动 = 0** |

## 3. Lead 补充事实（采信并复核）

- **无独立「加油包」字段**：`modelserver.rs` 新增 `topup_credits`/`topup_balance_text`/`credit_price`/`normalize_window_label`/`parse_subscription_windows` 五个纯函数，并以 `test_topup_credits_reads_wallet_balance_not_limits`（充值额度≠充值限额）、`test_topup_balance_text_never_fakes_conversion`（不伪造汇率换算）、`test_parse_subscription_windows_keeps_window_without_percent`（缺百分比窗口不丢弃）等 9 个用例固化 → `balance_credits` 为充值口径余额，标签「充值余额」正确。
- **`booster_wallet`（Kimi raw）当前不可显示**：`STATUS_DISABLED` 且 balance 对象无金额 → 前端无加油包可渲染；本轮不改标签（保留未来适配空间）。
- **`usedPercent` 为 null 的窗口**：前端 `validQuotaWindows` 只接受有限数字（`primaryMetric.ts:51-57`）→ 按规格忽略；若全部忽略则回落余额分支，**不崩**（探针实测）。

## 4. 门禁 / 越界

门禁见 AC-12；**PRE==POST**（门禁期间无写入）。**越界：无例外** —— 本轮写者仅 fe-k3（`src/**`：`primaryMetric.ts(.test)`、`drawerSections.ts(.test)`、`components/DrawerSection.tsx`、`ProviderCard.tsx(.test)`、`styles.css`）、开发 B（`src-tauri/src/providers/modelserver.rs`）、PM（`docs/`）。

## 5. 冻结哈希（sha256 前 16；PRE==POST）

`primaryMetric.ts cb476d4f236e3661`｜`primaryMetric.test.ts 39b8c43644789e12`｜`drawerSections.ts d67cf3d39521d921`｜`drawerSections.test.ts 46a3f58612a2d447`｜`DrawerSection.tsx 8b3a9ad3dc803ad6`｜`ProviderCard.tsx 032bd59400f7f13c`｜`ProviderCard.test.tsx 0896277d1e581b5d`｜`styles.css 4a97b500c5acb443`｜`modelserver.rs e099d8e17bfeeb57`。

## 6. 观察项（不阻断）

- **O-1**：DOM 类 AC 为「结构级 + 仓库 DOM 用例」双证（原因见开头）；其中「无 `$0`」有强结构依据 —— quota 分支不渲染任何金额、余额行要求 `amount > 0`。
- **O-2**：`ProviderCard.tsx:151-152` 对「后端 extras 已下发同名充值余额行」做去重，避免同口径双行 —— 好细节。
- **O-3**：`hasDailyUsageData` 把 `requests: 0` 视为**有效数据点**（规格原文「任一非 null」）→ 与规格一致；若将来想「全 0 也算空」属口径变更，本轮不动。
- **O-4**：fe-k3 自报前端 397，实测 **399**（+37）——仅计数差异，无害。

## 7. 结论

**建议推送**。AC-1..AC-12 全部有独立复算或结构级证据，无未达标项；本轮**无真机手测项**。可选（非阻塞）确认项：**卡片实际观感**（ModelServer 卡片首屏应显示「订阅剩余 100%」而非 `$0`）建议按 Lead 计划用独立 WebView2 目录启动截图核对一次 —— 纯显示逻辑已可在无 GUI 环境验证，故不列为门禁项。

## 8. 最终状态复核（Lead 告知 fe-k3 收尾写入后重跑）

fe-k3 的收尾对齐（次级行标签「充值余额」+ extras 同名行去重 + `usedPercent=null` 窗口回落）**已包含在本报告所冻结的修订内** —— 重跑得到**完全相同的哈希**（`primaryMetric.ts cb476d4f236e3661`、`drawerSections.ts d67cf3d39521d921`、`DrawerSection.tsx 8b3a9ad3dc803ad6`、`ProviderCard.tsx 032bd59400f7f13c`、`styles.css 4a97b500c5acb443`、`modelserver.rs e099d8e17bfeeb57`）与**相同的产物**（主入口 `main-DKpkciYA.js`：vite 报 135.66 kB / gzip 45.08、磁盘 146,918 B；summary 入口 5,538 B），故 **§5 哈希与 §7 结论继续有效**，无需重开冻结。

重跑门禁（同一修订）：`tsc` 0｜vitest **399/399**（22 文件，本机）与 **399/399**（TZ=UTC）｜`cargo test` **87 passed / 0 failed**｜clippy/fmt 0｜`vite build` 成功、两入口 `recharts` 命中均 0｜**PRE==POST**（门禁期间无写入）。
新增面独立复算（探针）：`usedPercent=null` 窗口被忽略 →（`balance=null`）`none` /（`balance=0`）`balance`；窗口名空白 → `当前窗口`；`validQuotaWindows` 只接受有限数字；`readBalanceCredits` 仅正数；精度 `73.14/100/73.1` 符合 AC-2 裁定；快照 1→`false`、2→`true` —— 全部通过。仓库新增 DOM 用例亦已实证：`getAllByText("充值余额").length === 1`（去重）与「`usedPercent` 为 null 不崩并回落余额分支」（`ProviderCard.test.tsx:152-168`），均在门禁 399 内实跑。

## 9. 增量复验（task-43：充值余额改条件产出）

**背景**：Lead 真机截图确认主指标改造生效（ModelServer 显示「100 %」+「7d · 7天后重置」，无 `$0`），但暴露 extras 仍有「充值余额 0.00 CNY」一行 → 与用户「如果有…再显示」不符。开发 B（task-42）把该 extra 改为条件产出。

**9.1 小修本身（独立 harness 实测，非采信汇报）**：在临时副本的 `providers::modelserver` 内注入自写测试（该函数为私有，无法从 crate 根访问，故注入模块内部；被审仓库零修改）——`topup_balance_extra(0.0/−3.0/NaN/+∞)` → **全部 `None`**（无占位行）；`50.0`（带单价/不带单价）→ `Some`，`key` 恰为「充值余额」且值非空。生产同款链路 `topup_credits(&v).and_then(|c| topup_balance_extra(c, credit_price(&v)))`：字段缺失 → `None`；**只有充值限额**（`max_topup/min_topup/daily_topup_limit_credits`）→ `None`；`balance_credits=0` → `None`；`=50` → `Some("充值余额")` ✅

**9.2 未连带改动其它 extras（逐项对比）**：`key:` 字面量集合 **HEAD 9 项 vs 现在 9 项**，差异**仅一处**：`钱包 credits` → `充值余额`（R19 早前的**文案对齐改名**，非本次小修引入；冻结修订里的去重正则 `充值余额|钱包\s*credits` 同时引用两名可为旁证）。本次小修**未增删任何键**，只把「充值余额」的 push 变为条件产出（`extras.push` 10→11 属 helper 抽取 + 过滤分支的结构性变化）；`balance` 语义未动（钱包 0 时仍 `{0, USD}`）。

**9.3 前端一致性（无冲突、无重复）**：前端 `readBalanceCredits` 仅认 `> 0`（`primaryMetric.ts:84-94`）与后端新行为**同判据**；后端已产出该 extra 时次级行被去重抑制（`ProviderCard.tsx:152` 正则命中「充值余额」+ `:252` 要求 `!extrasHasCreditsRow`）⇒ 余额 ≤0/缺失 → **0 行**；> 0 → **恰好 1 行**。既不会「后端不产出而前端仍显示」，也不会「两处都显示」✅

**9.4 重新冻结与门禁**：受影响文件仅 **`src-tauri/src/providers/modelserver.rs` → `59bcd724f5260637`**（其余 R19 文件哈希与 §5/§8 完全一致：`primaryMetric.ts cb476d4f236e3661`、`drawerSections.ts d67cf3d39521d921`、`ProviderCard.tsx 032bd59400f7f13c`、`DrawerSection.tsx 8b3a9ad3dc803ad6`、`styles.css 4a97b500c5acb443`、`App.tsx 86ebc2719c0b32f6`）→ 增量影响面精确收敛。门禁：`tsc` 0｜vitest **399/399**（本机）与 **399/399**（TZ=UTC）｜`cargo test` **90 passed / 0 failed / 7 ignored**（modelserver 文件内 12 个）｜`clippy -D warnings` exit 0｜`fmt --check` exit 0｜`vite build` 成功、入口 `main-DKpkciYA.js` 146,918 B、`recharts` 命中 0｜**PRE==POST**｜R14–R18 的 **276 条断言删除/改动 = 0**。

**9.5 已知限制（如实记录）**：① **macOS 浮层背景** —— R18 删除 `backgroundColor` 换取 Windows 透明圆角（用户主诉求），macOS 浮层无背景兜底，属已知限制；② **详情页空数据折叠目前仅由 DOM 用例验证** —— Lead 真机合成点击未能打开抽屉（点击未被应用接收），故该项**无真机视觉证据**，本轮以 `DrawerSection` 结构核对 + 仓库 DOM 用例为准。

**9.6 结论**：**建议推送**。本增量无未达标项；推送后按 Lead 计划再跑一次真机截图确认「充值余额 0.00」行已消失（主指标与窗口条不受影响）。

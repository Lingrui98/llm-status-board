# Round 23 计划：托盘区域额度可视化（文本条 + 图形条 + 数字限额转换）

## 0. 需求与定稿

用户：任务栏托盘区域优化额度显示——
1. 有额度百分比的账号要有「额度条」（圆环/直条由 Lead 决定）；
2. 多窗口账号（Kimi 5h/7d/月度）要显示全；
3. sub2api 数字限额账号（如 bosc：1d/7d/1m 上限+用量，USD 数字）转成百分比显示，或给开关。

**关键事实**（已核实）：
- 托盘有两个界面：右键**原生菜单**（只能文本，无法图形）+ 悬停**自绘浮层**（HTML，可图形）。「额度条」图形落在浮层；菜单用文本条（`█`/`░`）+ 子菜单承载多窗口。
- 真实数据（本机 results.json）：Kimi 有 5h/7d 两个百分比窗口；sub2api 站（bosc）有 `subscription.{daily,weekly,monthly}_{usage,limit}_usd` 数字对，当前只在 extras 里平铺（**日用量 201.79 / 上限 200 已超限却无任何直观提示**）。
- 主卡 `QuotaWindowBars` 已有直条视觉语言（fill=已用，<60 绿 / 60–80 琥珀 / >80 红 + 重置倒计时）。

## 1. 决策

| 问题 | 决定 | 理由 |
|---|---|---|
| 圆环还是直条 | **直条** | 多窗口纵向堆叠密度高、可读性好；与主卡 QuotaWindowBars 同一语言 |
| 条的语义 | **fill = 已用** | 与主卡一致（主指标文案仍是「剩余 X%」，R20 口径不动） |
| 数字→百分比转换位置 | **provider 层**（sub2api 产出结构化窗口） | 主指标/通知/浮层/菜单全局受益；extras 原样保留 |
| 超限（>100%） | 数据保留真实值；条宽 clamp 100%、数字显示真实「已用 101%」 | 超限是重要事实，不许被钳制吃掉 |
| 开关语义 | `quotaDetailDisplay: percent(默认)/raw`，只控制**窗口明细**呈现 | 主指标「剩余 X%」是 R20 三面贯通口径，不随显示开关漂移 |
| raw 模式无数字的窗口（如 Kimi） | 回落百分比显示 | 没有数字可显示时，诚实回落而不是空白 |
| 多窗口菜单呈现 | **Submenu**（主行=最紧窗口摘要，子项=每窗口一行 + 打开详情） | 不占主菜单高度（现有 8 行上限的考量不恶化） |

## 2. 改动清单

### Rust
1. `types.rs`：`QuotaWindow` += `used_amount` / `limit_amount: Option<Money>`（camelCase + default，旧 results.json 兼容）；`Settings` += `quota_detail_display: Option<String>`，`validate_settings` 白名单校验（percent/raw/None，余者拒绝——延续 AC-9 风格）。
2. `sub2api.rs`：新增纯函数 `subscription_quota_windows(v)`：`subscription` 下 daily/weekly/monthly 的 usage+limit 配对，limit>0 且 usage 存在 → `QuotaWindow{ window:"1d"/"7d"/"1m", used_percent: 真实比值（不 clamp）, used_amount, limit_amount, resets_at: None }`；在 unrestricted 与 legacy 回退两个分支统一挂上。extras 不动。
3. `tray.rs`：
   - `quota_bar_text(used_percent) -> String`：8 格文本条（已用格 `█`、剩余格 `░`，四舍五入）；
   - 账号项构建：`valid_windows` ≥2 → Submenu（子项 = 每窗口明细行（禁用）+ 分隔 + 「打开详情」）；==1 → 单行带条；0 → 原样；
   - percent/raw 两模式各一处纯函数产出文本（可单测）；
   - `rebuild_menu` 提升为 `pub(crate)`（供 save_config 调用）。
4. `commands.rs`：`save_config` 成功后重建托盘菜单（设置开关即时生效；失败不重建）。

### 前端
5. `types.ts`：QuotaWindow/Settings 同步两字段。
6. `summaryData.ts`：`SummaryRow` += `windows`（全部有效窗口透传）；`buildSummary` input += `quotaDisplay`。
7. `SummaryCard.tsx`：账号行下方渲染窗口明细区（每窗口一行：窗口名 + 直条 + 已用 N%（真实值）+ 重置倒计时；raw 模式 → `已用 A / 上限 L USD`，无 amount 回落百分比）。
8. `summary.css`：明细区紧凑直条样式（沿用 quota-track/quota-fill 色系，尺寸适配 300px 浮层）。
9. `SettingsView.tsx`：「通用设置」加「限额窗口明细：百分比条 / 原始数字」开关（SegmentedControl）。

### 测试与门禁
- Rust 单测：转换函数（配对/limit≤0/缺 usage/超限不 clamp）、文本条、单行与子菜单文本两模式；CI 跑 fmt/clippy/test（本机无工具链，commit 注明）。
- TS 单测：buildSummary windows 透传 + 模式切换；明细文本纯函数。
- 本地：npm test + npm run build。
- 发版：v0.2.6（设计/冻结/评审文档随附）。

## 3. 明确不做
- 不改主卡主指标与通知口径（R19/R20 既定）；
- 菜单 tooltip 不动；浮层 300×360 尺寸不动（明细区滚动已有）；
- rate_limits 路径（quota_limited）现有 `.min(100)` 行为保持不动（不扩散）。

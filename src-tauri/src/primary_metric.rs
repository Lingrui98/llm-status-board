//! R20 主指标口径（与前端 `src/primaryMetric.ts` 等价的纯函数）。
//!
//! **单一事实来源**：托盘右键菜单（`tray.rs#tray_status_text`）只保留「失败分支」并调用本模块，
//! 不再自己判定；悬停浮层由前端复用同一口径（`formatPrimaryMetricLine`）。
//! 规格：`docs/round-20-plan.md` §1（规范串）/§2（单一事实来源）/§3（黄金表）。
//!
//! 判定顺序（与前端 `pickPrimaryMetric` 完全一致）：
//! 1. 有效窗口 ≥1 **且**（余额 null 或 amount == 0）→ 订阅优先：`剩余 {剩余}%（{窗口名}）`
//! 2. 否则有余额 → `{金额} {币种}`（含「无窗口 + 余额 0」：`0.00 USD` 是真实信息）
//! 3. 余额 null 且无有效窗口 → `—`

use crate::types::{AccountInfo, QuotaWindow};

/// 窗口名缺失/空白时的兜底文案（与前端 `DEFAULT_WINDOW_LABEL` 逐字一致）
pub const DEFAULT_WINDOW_LABEL: &str = "当前窗口";

/// 主指标判定结果
#[derive(Debug, Clone, PartialEq)]
pub enum PrimaryMetric {
    /// 无数据（余额 null 且无有效窗口）→ `—`
    None,
    /// 余额优先 → `{金额} {币种}`
    Balance { amount: f64, currency: String },
    /// 订阅优先 → `剩余 {剩余}%（{窗口名}）`
    Quota {
        /// 展示用剩余文本（整数不带小数、最多 2 位、去尾 0）
        remaining_text: String,
        /// 窗口名（缺失/空白已兜底为 [`DEFAULT_WINDOW_LABEL`]）
        window_label: String,
    },
}

/// 钳制到 `[0,100]`；非有限值按 `0`（与前端 `clampPercent` 一致）
pub(crate) fn clamp_percent(pct: f64) -> f64 {
    if pct.is_finite() {
        pct.clamp(0.0, 100.0)
    } else {
        0.0
    }
}

/// 四舍五入到 2 位小数（等价前端 `Number((100 - used).toFixed(2))`）
fn round2(v: f64) -> f64 {
    if v.is_finite() {
        (v * 100.0).round() / 100.0
    } else {
        0.0
    }
}

/// 去尾 0 的数字文本（最多 2 位）：`100`→`100`、`73.14`→`73.14`、`73.1`→`73.1`、`0`→`0`
/// （与前端 `trimNumberText` 一致）
pub(crate) fn trim_number_text(v: f64) -> String {
    if !v.is_finite() || v == 0.0 {
        return "0".to_string();
    }
    let mut s = format!("{v:.2}");
    if s.contains('.') {
        while s.ends_with('0') {
            s.pop();
        }
        if s.ends_with('.') {
            s.pop();
        }
    }
    s
}

/// 金额小数位（规格 §1）：`|v|≥1`→2 位、`0.01≤|v|<1`→4 位、`0<|v|<0.01`→6 位、**`0`→`0.00`**。
/// 非有限值（JSON 不可能出现）用「—」，不产出 NaN。
pub(crate) fn format_decimal(v: f64) -> String {
    if !v.is_finite() {
        return "—".to_string();
    }
    if v == 0.0 {
        return "0.00".to_string();
    }
    let abs = v.abs();
    if abs < 0.01 {
        format!("{v:.6}")
    } else if abs < 1.0 {
        format!("{v:.4}")
    } else {
        format!("{v:.2}")
    }
}

/// 有效窗口 = `used_percent` 为**有限**数字者（`null`/`NaN` 一律忽略该窗口）
pub(crate) fn valid_windows(windows: &[QuotaWindow]) -> Vec<&QuotaWindow> {
    windows
        .iter()
        .filter(|w| w.used_percent.is_some_and(f64::is_finite))
        .collect()
}

/// 最紧窗口 = 钳制后 `used_percent` 最大者；同值取**先出现**者（与前端 `tightestWindow` 一致）
pub(crate) fn tightest_window(windows: &[QuotaWindow]) -> Option<&QuotaWindow> {
    let mut best: Option<&QuotaWindow> = None;
    let mut best_pct = f64::NEG_INFINITY;
    for w in valid_windows(windows) {
        let pct = clamp_percent(w.used_percent.unwrap_or(0.0));
        if best.is_none() || pct > best_pct {
            best = Some(w);
            best_pct = pct;
        }
    }
    best
}

/// 主指标判定（判定顺序见模块文档；越界钳制 `<0→100%剩余`、`>100→0%剩余`）
pub fn pick_primary_metric(info: &AccountInfo) -> PrimaryMetric {
    let balance = info.balance.as_ref();
    let has_valid_window = !valid_windows(&info.quota_windows).is_empty();
    let balance_zero_or_null = balance.is_none_or(|b| b.amount == 0.0);

    if has_valid_window && balance_zero_or_null {
        if let Some(w) = tightest_window(&info.quota_windows) {
            let used = clamp_percent(w.used_percent.unwrap_or(0.0));
            let remaining_percent = round2(100.0 - used);
            let label = w
                .window
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(DEFAULT_WINDOW_LABEL);
            return PrimaryMetric::Quota {
                remaining_text: trim_number_text(remaining_percent),
                window_label: label.to_string(),
            };
        }
    }

    match balance {
        Some(b) => PrimaryMetric::Balance {
            amount: b.amount,
            currency: b.currency.clone(),
        },
        None => PrimaryMetric::None,
    }
}

/// 规范串（规格 §1）：订阅 → `剩余 X%（窗口名）`；余额 → `{金额} {币种}`；无数据 → `—`
pub fn format_primary_metric_line(metric: &PrimaryMetric) -> String {
    match metric {
        PrimaryMetric::None => "—".to_string(),
        PrimaryMetric::Balance { amount, currency } => {
            format!("{} {}", format_decimal(*amount), currency)
        }
        PrimaryMetric::Quota {
            remaining_text,
            window_label,
        } => format!("剩余 {remaining_text}%（{window_label}）"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Money;

    fn info(
        balance: Option<(f64, &str)>,
        windows: Vec<(Option<&str>, Option<f64>)>,
    ) -> AccountInfo {
        AccountInfo {
            balance: balance.map(|(amount, currency)| Money {
                amount,
                currency: currency.into(),
            }),
            quota_windows: windows
                .into_iter()
                .map(|(window, used_percent)| QuotaWindow {
                    window: window.map(String::from),
                    used_percent,
                    resets_at: None,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }

    /// 去尾 0（最多 2 位）与前端 `trimNumberText` 逐字一致
    #[test]
    fn trim_number_text_matches_frontend() {
        assert_eq!(trim_number_text(100.0), "100");
        assert_eq!(trim_number_text(73.14), "73.14");
        assert_eq!(trim_number_text(73.1), "73.1");
        assert_eq!(trim_number_text(0.0), "0");
        assert_eq!(trim_number_text(f64::NAN), "0");
        assert_eq!(trim_number_text(64.4), "64.4");
    }

    /// 金额小数位规则（规格 §1）：0 → `0.00`；`0.5` → `0.5000`；`12.5` → `12.50`
    #[test]
    fn format_decimal_pins_spec_digits() {
        assert_eq!(format_decimal(0.0), "0.00");
        assert_eq!(format_decimal(12.5), "12.50");
        assert_eq!(format_decimal(0.5), "0.5000");
        assert_eq!(format_decimal(0.005), "0.005000");
        assert_eq!(format_decimal(-12.5), "-12.50");
        // 非有限值不产出 NaN
        assert_eq!(format_decimal(f64::NAN), "—");
    }

    /// 越界钳制与非有限百分比
    #[test]
    fn clamp_percent_bounds_and_non_finite() {
        assert_eq!(clamp_percent(-5.0), 0.0);
        assert_eq!(clamp_percent(150.0), 100.0);
        assert_eq!(clamp_percent(26.86), 26.86);
        assert_eq!(clamp_percent(f64::NAN), 0.0);
    }

    /// 订阅优先只在「余额 null 或 0」时成立；余额非 0 一律走余额（G1 vs G3 的纯函数版本）
    #[test]
    fn quota_takes_priority_only_for_zero_or_null_balance() {
        let windows = vec![(Some("7d"), Some(90.0))];
        // 余额 0 → 订阅优先（剩余 10%）
        let zero = pick_primary_metric(&info(Some((0.0, "USD")), windows.clone()));
        assert_eq!(
            format_primary_metric_line(&zero),
            "剩余 10%（7d）",
            "余额 0 应走订阅口径"
        );
        // 余额 12.5 → 余额优先
        let paid = pick_primary_metric(&info(Some((12.5, "USD")), windows));
        assert_eq!(format_primary_metric_line(&paid), "12.50 USD");
        // 余额 null + 无有效窗口 → 无数据
        let empty = pick_primary_metric(&info(None, vec![]));
        assert_eq!(format_primary_metric_line(&empty), "—");
    }
}

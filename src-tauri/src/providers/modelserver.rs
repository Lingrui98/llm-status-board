//! ModelServer（code.cs.ac.cn / ETOChat 拼车面板）适配器
//!
//! 认证：refresh_token → POST /api/v1/auth/refresh 轮转出新的 access/refresh token（回写配置）
//! 查询链：GET /api/v1/me（用户）→ GET /api/v1/projects?per_page=100（项目 ID）
//!        → GET /api/v1/projects/{id}/extra-usage（钱包余额，credits × 单价）
//!        → GET /api/v1/projects/{id}/subscription/usage（5h/7d 订阅窗口）

use crate::http;
use crate::jsonpath::{lookup_number, lookup_string};
use crate::types::{AccountConfig, AccountInfo, KeyValue, Money};
use serde_json::{json, Value};

/// 站点地址归一化：
/// - 补默认 scheme
/// - 剥掉用户粘贴面板网址时带的路径（如 /projects/xxx）
/// - 前端面板域（code. 开头）改写为 API 后端域（codeapi. 开头）——
///   面板网页是纯静态 SPA，API 全部在 codeapi 子域上
pub(crate) fn normalize_base(raw: &str) -> String {
    let t = raw.trim().trim_end_matches('/');
    let (scheme, rest) = match t.split_once("://") {
        Some((s, r)) => (s, r),
        None => ("https", t),
    };
    let host = rest.split('/').next().unwrap_or(rest);
    let host = if let Some(stripped) = host.strip_prefix("code.") {
        // 已是 codeapi. 的不动；其余 code. 域名改写为 codeapi.
        format!("codeapi.{stripped}")
    } else {
        host.to_string()
    };
    format!("{scheme}://{host}")
}

pub async fn fetch(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let base = normalize_base(&acc.base_url);
    let mut access = acc.token.clone();
    let mut new_access: Option<String> = None;
    let mut new_refresh: Option<String> = None;

    if access.is_empty() && acc.refresh_token.is_empty() {
        return Err(
            "请先在网页面板（code.cs.ac.cn）登录，然后 F12 → Application → Local Storage \
             → 复制 refresh_token 的值填到下方「refresh_token」框"
                .into(),
        );
    }

    // 优先用 refresh_token 换新 access token（避免短期 access token 过期问题）
    if !acc.refresh_token.is_empty() {
        let url = format!("{base}/api/v1/auth/refresh");
        let body = json!({ "refresh_token": acc.refresh_token }).to_string();
        let v = http::send_json(client, "POST", &url, &[], Some(&body)).await?;
        let access_t = lookup_string(&v, "access_token").ok_or("refresh 响应缺少 access_token")?;
        let refresh_t = lookup_string(&v, "refresh_token").unwrap_or_default();
        access = access_t.clone();
        new_access = Some(access_t);
        new_refresh = if refresh_t.is_empty() {
            None
        } else {
            Some(refresh_t)
        };
    }

    let auth_value = format!("Bearer {access}");

    // 用户信息
    let mut info = AccountInfo {
        new_token: new_access,
        new_refresh_token: new_refresh,
        fetched_at: crate::types::now_iso(),
        ..Default::default()
    };
    if let Ok(me) = http::send_json(
        client,
        "GET",
        &format!("{base}/api/v1/me"),
        &[("Authorization", auth_value.clone())],
        None,
    )
    .await
    {
        if let Some(n) = lookup_string(&me, "nickname").or_else(|| lookup_string(&me, "email")) {
            info.note = Some(format!("已登录：{n}"));
        }
    }

    // 项目列表
    let projects = http::send_json(
        client,
        "GET",
        &format!("{base}/api/v1/projects?per_page=100"),
        &[("Authorization", auth_value.clone())],
        None,
    )
    .await?;
    let list = projects
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    if list.is_empty() {
        info.note = Some("已登录，但没有找到项目".into());
        return Ok(info);
    }

    // 汇总所有项目（钱包余额可能以 CNY 或 USD 计价）
    let mut total_cny = 0.0;
    let mut total_usd = 0.0;
    let mut has_wallet = false;
    let mut credits_without_price: Vec<(String, f64)> = Vec::new();
    let mut project_names: Vec<String> = Vec::new();
    let mut raws: Vec<Value> = Vec::new();

    for p in list.iter().take(10) {
        // 项目 ID 可能是数字也可能是 UUID 字符串（取决于部署版本），统一取字符串形式
        let pid = if let Some(id) = p.get("id").and_then(|i| i.as_i64()) {
            id.to_string()
        } else if let Some(id) = p.get("id").and_then(|i| i.as_str()) {
            id.to_string()
        } else {
            continue;
        };
        let project_name = p
            .get("name")
            .and_then(|n| n.as_str())
            .unwrap_or("")
            .to_string();
        if !project_name.is_empty() {
            project_names.push(project_name.clone());
        }

        // 钱包余额（extra-usage）
        let extra = http::send_json(
            client,
            "GET",
            &format!("{base}/api/v1/projects/{pid}/extra-usage"),
            &[("Authorization", auth_value.clone())],
            None,
        )
        .await;
        match extra {
            Ok(v) => {
                let d = v.get("data").cloned().unwrap_or(v.clone());
                let credits = topup_credits(&d);
                let price = credit_price(&d);
                match (credits, price) {
                    (Some(c), Some((per_credit, currency))) => {
                        let amount = c * per_credit;
                        has_wallet = true;
                        // R19 侦查结论：本面板**没有**独立的「加油包/充值包」余额字段，
                        // 「加油包」等价于钱包充值余额（`balance_credits`）。
                        // R19 修正：用户要求「**如果有**加油包余额**再**显示加油包」——
                        // 只有余额 > 0 才产出这一行，0/缺失都不显示（也不给「—」占位）。
                        if let Some(kv) = topup_balance_extra(c, Some((per_credit, currency))) {
                            info.extras.push(kv);
                        }
                        match currency {
                            "CNY" => total_cny += amount,
                            _ => total_usd += amount,
                        }
                        // 本月钱包消费（同一单价）
                        if let Some(spent) = lookup_number(&d, "monthly_spent_credits") {
                            info.extras.push(KeyValue {
                                key: "本月钱包消费".into(),
                                value: format!("{:.2} {currency}", spent * per_credit),
                            });
                        }
                    }
                    (Some(c), None) => {
                        // 有 credits 但没有单价：展示原始值，不折算
                        credits_without_price.push((project_name.clone(), c));
                    }
                    (None, _) => {
                        // 未启用钱包（纯订阅制）
                    }
                }
                raws.push(d);
            }
            Err(e) => {
                // extra-usage 不存在或未启用（纯订阅制）
                info.extras.push(KeyValue {
                    key: "钱包查询".into(),
                    value: e,
                });
            }
        }

        // 订阅窗口（5h / 7d；若接口给出 1d/月度等同理）→ 结构化配额窗口
        // （参照 Mac 版：优先订阅源，percentage ?? utilization）
        if let Ok(usage) = http::send_json(
            client,
            "GET",
            &format!("{base}/api/v1/projects/{pid}/subscription/usage"),
            &[("Authorization", auth_value.clone())],
            None,
        )
        .await
        {
            for (label, pct, resets_at) in parse_subscription_windows(&usage) {
                if let Some(p) = pct {
                    info.extras.push(KeyValue {
                        key: format!("{label} 窗口"),
                        value: format!("{p:.0}%"),
                    });
                }
                // R19：即使该窗口没有百分比（接口给了窗口却没给用量）也要保留，
                // 不能因缺 used_percent 就把整条窗口丢掉
                info.quota_windows.push(crate::types::QuotaWindow {
                    window: Some(label),
                    used_percent: pct,
                    resets_at,
                });
            }
        }

        // 用量概览 + 成本明细（官方价 / 实付 / 节省，fen → 元）
        if let Ok(overview) = http::send_json(
            client,
            "GET",
            &format!("{base}/api/v1/projects/{pid}/usage"),
            &[("Authorization", auth_value.clone())],
            None,
        )
        .await
        {
            let d = overview.get("data").cloned().unwrap_or(overview.clone());
            if info.requests.is_none() {
                if let Some(rc) = crate::jsonpath::lookup_i64(&d, "request_count") {
                    info.requests = Some(rc);
                }
            }
            if let Some(cb) = d.get("cost_breakdown") {
                let fen = |k: &str| lookup_number(cb, k).map(|f| f / 100.0);
                let api_std = fen("api_standard_fen");
                let paid = fen("actual_paid_fen");
                let saved =
                    fen("saved_fen").or_else(|| api_std.zip(paid).map(|(s, p)| (s - p).max(0.0)));
                if let Some(s) = api_std {
                    info.extras.push(KeyValue {
                        key: "官方标准价".into(),
                        value: format!("{s:.2} CNY"),
                    });
                }
                if let Some(p) = paid {
                    info.extras.push(KeyValue {
                        key: "本期实付".into(),
                        value: format!("{p:.2} CNY"),
                    });
                }
                if let (Some(s), Some(v)) = (api_std, saved) {
                    if s > 0.0 {
                        info.extras.push(KeyValue {
                            key: "订阅节省".into(),
                            value: format!("{v:.2} CNY（{:.0}%）", v / s * 100.0),
                        });
                    }
                }
                if let Some((start, end)) =
                    lookup_string(cb, "period_start").zip(lookup_string(cb, "period_end"))
                {
                    let fmt_short = |iso: &str| iso.get(..10).unwrap_or(iso).to_string();
                    info.extras.push(KeyValue {
                        key: "统计周期".into(),
                        value: format!("{} ~ {}", fmt_short(&start), fmt_short(&end)),
                    });
                }
            }
        }

        // 按日用量（统计图；credits 计）
        if let Ok(daily) = http::send_json(
            client,
            "GET",
            &format!("{base}/api/v1/projects/{pid}/usage?breakdown=daily"),
            &[("Authorization", auth_value.clone())],
            None,
        )
        .await
        {
            let data = daily.get("data").cloned().unwrap_or(daily.clone());
            if let Some(arr) = data.as_array() {
                for d in arr {
                    info.daily_usage.push(crate::types::UsagePoint {
                        date: lookup_string(d, "date"),
                        requests: crate::jsonpath::lookup_i64(d, "request_count"),
                        input_tokens: lookup_number(d, "total_input_tokens"),
                        output_tokens: lookup_number(d, "total_output_tokens"),
                        tokens: lookup_number(d, "total_tokens"),
                        // total_credits_k：千 credits → 原始 credits
                        cost: lookup_number(d, "total_credits_k").map(|k| k * 1000.0),
                        cost_unit: Some("credits".into()),
                        latency_ms: lookup_number(d, "avg_latency_ms"),
                        model: None,
                    });
                }
            }
        }

        // 按模型用量（统计图；按 credits 降序）
        if let Ok(models) = http::send_json(
            client,
            "GET",
            &format!("{base}/api/v1/projects/{pid}/usage?breakdown=model"),
            &[("Authorization", auth_value.clone())],
            None,
        )
        .await
        {
            let data = models.get("data").cloned().unwrap_or(models.clone());
            if let Some(arr) = data.as_array() {
                for m in arr {
                    info.model_usage.push(crate::types::UsagePoint {
                        model: lookup_string(m, "model"),
                        requests: crate::jsonpath::lookup_i64(m, "request_count"),
                        input_tokens: lookup_number(m, "total_input_tokens"),
                        output_tokens: lookup_number(m, "total_output_tokens"),
                        tokens: lookup_number(m, "total_tokens"),
                        cost: lookup_number(m, "total_credits_k").map(|k| k * 1000.0),
                        cost_unit: Some("credits".into()),
                        latency_ms: lookup_number(m, "avg_latency_ms"),
                        date: None,
                    });
                }
                info.model_usage
                    .sort_by(|a, b| b.cost.unwrap_or(0.0).total_cmp(&a.cost.unwrap_or(0.0)));
            }
        }
    }

    if has_wallet {
        // 优先展示人民币钱包；两种币都有时把美元作为附加行
        if total_cny > 0.0 {
            info.balance = Some(Money {
                amount: total_cny,
                currency: "CNY".into(),
            });
            if total_usd > 0.0 {
                info.extras.push(KeyValue {
                    key: "美元钱包合计".into(),
                    value: format!("{total_usd:.2} USD"),
                });
            }
        } else {
            info.balance = Some(Money {
                amount: total_usd,
                currency: "USD".into(),
            });
        }
    } else if !credits_without_price.is_empty() {
        // 有 credits 但没有可折算的单价：展示原始值。
        // R19 修正：仍然只在余额 > 0 时才产出「充值余额」行（0 不显示、不给占位）。
        // 注意这里保留 `credits_without_price` 非空判定本身不变，
        // 以免影响下方「纯订阅模式」备注的既有分支语义。
        let shown = credits_without_price
            .iter()
            .filter(|(_, c)| *c > 0.0)
            .map(|(name, c)| {
                if name.is_empty() {
                    format!("{c:.0} credits")
                } else {
                    format!("{name}: {c:.0}")
                }
            })
            .collect::<Vec<_>>()
            .join("、");
        if !shown.is_empty() {
            info.extras.push(KeyValue {
                key: "充值余额".into(),
                value: shown,
            });
        }
    } else {
        // 保留已有的「已登录：xxx」备注，只追加订阅模式说明
        let prefix = info.note.clone().unwrap_or_default();
        let suffix = "纯订阅模式（无钱包余额），窗口用量见下方";
        info.note = Some(if prefix.is_empty() {
            suffix.to_string()
        } else {
            format!("{prefix}；{suffix}")
        });
    }
    if !project_names.is_empty() {
        let shown = project_names.join("、");
        info.extras.push(KeyValue {
            key: "项目".into(),
            value: shown,
        });
    }
    info.raw = Some(if raws.len() == 1 {
        raws.into_iter().next().unwrap()
    } else {
        Value::Array(raws)
    });

    Ok(info)
}

/// 从 extra-usage 数据里取 credits 单价：返回 (每 credit 价格, 币种)
/// - cny_fen_per_million：每百万 credits 的人民币分 → 元/credit = fen / 1e6
/// - usd_cents_per_million：每百万 credits 的美分 → 美元/credit = cents / 1e6
fn credit_price(data: &Value) -> Option<(f64, &'static str)> {
    if let Some(fen) = lookup_number(data, "credit_unit_prices.cny_fen_per_million") {
        return Some((fen / 1_000_000.0, "CNY"));
    }
    if let Some(cents) = lookup_number(data, "credit_unit_prices.usd_cents_per_million") {
        return Some((cents / 1_000_000.0, "USD"));
    }
    None
}

/// R19 侦察结论：本面板（`codeapi.cs.ac.cn`）**没有**独立的「加油包/充值包」余额字段。
/// 钱包口径余额只有 `balance_credits`；而 `max_topup` / `min_topup` /
/// `daily_topup_limit_credits` 是**充值限额**（一次/一天最多能充多少），**不是余额**。
/// 因此「加油包」在本面板等价于钱包充值余额 —— 只认 `balance_credits`，绝不把限额当余额。
fn topup_credits(data: &Value) -> Option<f64> {
    lookup_number(data, "balance_credits")
}

/// 充值余额文案（R19）：有单价才折算金额，无单价则原样 credits（不做假换算）。
/// `0` 就是 `0.00`/`0 credits`，照实显示。
/// JSON 不可能携带 NaN/Infinity；万一上游给出非有限值，用「—」而不是显示 "NaN"
/// （本项目「无数据」的统一写法，也不伪造数字）。
fn topup_balance_text(credits: f64, price: Option<(f64, &'static str)>) -> String {
    if !credits.is_finite() {
        return "—".to_string();
    }
    match price {
        Some((per_credit, currency)) => format!("{:.2} {currency}", credits * per_credit),
        None => format!("{credits:.0} credits"),
    }
}

/// R19 修正：「充值余额」这条 extras 是**条件显示**的——
/// 用户要求「**如果有**加油包余额**再**显示加油包」，所以仅当充值口径余额 `> 0` 才产出；
/// `0`（含负数/NaN）与字段缺失都返回 `None`，不做「充值余额 —」之类的占位行。
fn topup_balance_extra(credits: f64, price: Option<(f64, &'static str)>) -> Option<KeyValue> {
    // 先排除 NaN/Infinity（不能用 `!(credits > 0.0)` 之外的花招：NaN 必须落在这边），
    // 再要求严格大于 0。
    if !credits.is_finite() || credits <= 0.0 {
        return None;
    }
    Some(KeyValue {
        key: "充值余额".into(),
        value: topup_balance_text(credits, price),
    })
}

/// 订阅窗口名归一（R19：补齐 1d/月度等别名；未知窗口保持原样，不丢信息）
fn normalize_window_label(window: &str) -> &str {
    match window {
        "five_hour" | "5h" => "5h",
        "seven_day" | "7d" => "7d",
        "daily" | "one_day" | "24h" | "1d" => "1d",
        "monthly" | "thirty_day" | "30d" => "月度",
        other => other,
    }
}

/// 解析 `subscription/usage` 的窗口（R19，纯函数便于单测）。
///
/// 返回 `(可读标签, 百分比, 重置时间)`：
/// - 兼容 `{data:{windows:[…]}}` 与「直接是数组」两种返回；
/// - 百分比取 `used_percent` ?? `percentage` ?? `utilization`；
/// - **不因缺百分比就丢弃窗口**：只要还带重置时间等信息就保留；
///   两者都没有（纯占位）才跳过。
fn parse_subscription_windows(payload: &Value) -> Vec<(String, Option<f64>, Option<String>)> {
    let data = payload
        .get("data")
        .cloned()
        .unwrap_or_else(|| payload.clone());
    let windows = data
        .get("windows")
        .and_then(|w| w.as_array())
        .cloned()
        .unwrap_or_else(|| data.as_array().cloned().unwrap_or_default());
    let mut out = Vec::new();
    for w in windows {
        let window = w.get("window").and_then(|x| x.as_str()).unwrap_or("?");
        let pct = w
            .get("used_percent")
            .and_then(|x| x.as_f64())
            .or_else(|| w.get("percentage").and_then(|x| x.as_f64()))
            .or_else(|| w.get("utilization").and_then(|x| x.as_f64()));
        let resets_at = w
            .get("resets_at")
            .and_then(|r| r.as_str())
            .map(String::from);
        if pct.is_none() && resets_at.is_none() {
            continue;
        }
        out.push((normalize_window_label(window).to_string(), pct, resets_at));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{
        credit_price, normalize_base, normalize_window_label, parse_subscription_windows,
        topup_balance_extra, topup_balance_text, topup_credits,
    };
    use serde_json::json;

    #[test]
    fn test_normalize_base() {
        // 前端面板域 → API 后端域
        assert_eq!(
            normalize_base("https://code.cs.ac.cn"),
            "https://codeapi.cs.ac.cn"
        );
        // 粘贴的带路径面板网址 → 剥路径 + 换 API 域
        assert_eq!(
            normalize_base("https://code.cs.ac.cn/projects/7f8a635a-58c4-4140-ad37-2e9b3c0a56e4"),
            "https://codeapi.cs.ac.cn"
        );
        // 已是 API 域的不动
        assert_eq!(
            normalize_base("https://codeapi.cs.ac.cn"),
            "https://codeapi.cs.ac.cn"
        );
        assert_eq!(
            normalize_base("https://codeapi.cs.ac.cn/"),
            "https://codeapi.cs.ac.cn"
        );
        // 无 scheme 补 https；其他域只剥路径
        assert_eq!(normalize_base("code.cs.ac.cn"), "https://codeapi.cs.ac.cn");
        assert_eq!(
            normalize_base("https://other.example.com/v1"),
            "https://other.example.com"
        );
        assert_eq!(
            normalize_base("other.example.com"),
            "https://other.example.com"
        );
    }

    #[test]
    fn test_credit_price_cny_preferred() {
        let d = json!({
            "balance_credits": 5000,
            "credit_unit_prices": { "cny_fen_per_million": 40000, "usd_cents_per_million": 5600 }
        });
        let (per_credit, currency) = credit_price(&d).unwrap();
        assert_eq!(currency, "CNY");
        assert!(
            (per_credit - 0.04).abs() < 1e-12,
            "40000 分/百万 = 0.04 元/credit"
        );
        // 5000 credits × 0.04 = 200 元
        assert!((5000.0 * per_credit - 200.0).abs() < 1e-9);
    }

    #[test]
    fn test_credit_price_usd_fallback() {
        let d = json!({ "credit_unit_prices": { "usd_cents_per_million": 5600 } });
        let (per_credit, currency) = credit_price(&d).unwrap();
        assert_eq!(currency, "USD");
        assert!((per_credit - 0.0056).abs() < 1e-12);
    }

    #[test]
    fn test_credit_price_missing() {
        let d = json!({ "balance_credits": 100 });
        assert!(credit_price(&d).is_none());
        assert!(credit_price(&json!({})).is_none());
    }

    // ---------- R19：加油包口径 + 订阅窗口完整性 ----------

    /// 侦察结论固化：只有 `balance_credits` 算充值余额；
    /// `max_topup`/`min_topup`/`daily_topup_limit_credits` 是**充值限额**，绝不能被当成余额
    #[test]
    fn test_topup_credits_reads_wallet_balance_not_limits() {
        // 本机实测的真实字段组合（值为演示数，无凭证）
        let real_shape = json!({
            "balance_credits": 0,
            "daily_topup_limit_credits": 200000,
            "max_topup": { "cny_fen": 100000, "usd_cents": 1400 },
            "min_topup": { "cny_fen": 1000, "usd_cents": 14 },
            "monthly_limit_credits": 0,
            "monthly_spent_credits": 0
        });
        assert_eq!(
            topup_credits(&real_shape),
            Some(0.0),
            "0 就是 0，不得为了好看变成 None 或别的值"
        );

        // 只有充值限额、没有 balance_credits → 不能当成余额
        let limits_only = json!({
            "daily_topup_limit_credits": 200000,
            "max_topup": { "cny_fen": 100000 },
            "min_topup": { "cny_fen": 1000 }
        });
        assert_eq!(topup_credits(&limits_only), None, "充了多少的上限不是余额");
        assert_eq!(topup_credits(&json!({})), None);
    }

    /// 充值余额文案：有单价折算、无单价原样 credits，绝不产出 null/NaN
    #[test]
    fn test_topup_balance_text_never_fakes_conversion() {
        assert_eq!(
            topup_balance_text(5000.0, Some((0.04, "CNY"))),
            "200.00 CNY"
        );
        assert_eq!(topup_balance_text(0.0, Some((0.0056, "USD"))), "0.00 USD");
        assert_eq!(topup_balance_text(0.0, None), "0 credits");
        assert_eq!(topup_balance_text(1234.0, None), "1234 credits");
        // 非有限值（JSON 不可能出现）→ 统一「—」，不显示 NaN/Infinity
        assert_eq!(topup_balance_text(f64::NAN, None), "—");
        assert_eq!(topup_balance_text(f64::INFINITY, None), "—");
        for text in [
            topup_balance_text(0.0, None),
            topup_balance_text(f64::NAN, None),
        ] {
            assert!(!text.contains("NaN"), "不得输出 NaN: {text}");
            assert!(!text.contains("inf"), "不得输出 inf: {text}");
            assert!(!text.contains("null"), "不得输出 null: {text}");
        }
    }

    /// 窗口名归一：已知窗口得到可读标签，未知窗口原样保留（不丢信息）
    #[test]
    fn test_window_labels_normalized() {
        assert_eq!(normalize_window_label("five_hour"), "5h");
        assert_eq!(normalize_window_label("5h"), "5h");
        assert_eq!(normalize_window_label("seven_day"), "7d");
        assert_eq!(normalize_window_label("7d"), "7d");
        assert_eq!(normalize_window_label("daily"), "1d");
        assert_eq!(normalize_window_label("1d"), "1d");
        assert_eq!(normalize_window_label("monthly"), "月度");
        assert_eq!(normalize_window_label("30d"), "月度");
        assert_eq!(normalize_window_label("weird_window"), "weird_window");
    }

    /// 兼容 `{data:{windows:[…]}}` 与「直接数组」两种返回，并支持
    /// `used_percent`/`percentage`/`utilization` 三种百分比字段
    #[test]
    fn test_parse_subscription_windows_shapes_and_pct_fields() {
        let wrapped = json!({
            "data": { "windows": [
                { "window": "seven_day", "used_percent": 12.5, "resets_at": "2026-10-22T00:00:00Z" }
            ]}
        });
        let got = parse_subscription_windows(&wrapped);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "7d");
        assert_eq!(got[0].1, Some(12.5));
        assert_eq!(got[0].2.as_deref(), Some("2026-10-22T00:00:00Z"));

        let bare = json!([
            { "window": "five_hour", "percentage": 30.0 },
            { "window": "monthly", "utilization": 66.0 }
        ]);
        let got = parse_subscription_windows(&bare);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].0, "5h");
        assert_eq!(got[0].1, Some(30.0));
        assert_eq!(got[1].0, "月度");
        assert_eq!(got[1].1, Some(66.0));
    }

    /// 窗口缺失分支：接口给了窗口但**没给百分比**时不得整条丢弃（有重置时间就保留）；
    /// 纯占位（无百分比也无重置时间）才跳过
    #[test]
    fn test_parse_subscription_windows_keeps_window_without_percent() {
        let payload = json!({
            "data": { "windows": [
                // 只有窗口名与重置时间：本机 ModelServer 实测「只有 7d」，
                // 但接口未来若给出无百分比的窗口，也必须保留而不是静默丢掉
                { "window": "seven_day", "resets_at": "2026-10-22T00:00:00Z" },
                // 纯占位：什么都没有 → 跳过
                { "window": "monthly" }
            ]}
        });
        let got = parse_subscription_windows(&payload);
        assert_eq!(got.len(), 1, "无百分比但有重置时间要保留，纯占位才跳过");
        assert_eq!(got[0].0, "7d");
        assert_eq!(got[0].1, None);
        assert_eq!(got[0].2.as_deref(), Some("2026-10-22T00:00:00Z"));

        // 空 windows / 缺字段：都退化为空，不 panic
        assert!(parse_subscription_windows(&json!({ "data": { "windows": [] } })).is_empty());
        assert!(parse_subscription_windows(&json!({})).is_empty());
    }

    // ---------- R19 修正：「充值余额」条件显示 ----------

    /// credits = 0 → **不产出**「充值余额」行（用户要求「如果有…再显示」）
    #[test]
    fn test_topup_extra_hidden_when_zero() {
        assert!(topup_balance_extra(0.0, Some((0.04, "CNY"))).is_none());
        assert!(topup_balance_extra(0.0, None).is_none());
        // 负数 / NaN 同样不显示
        assert!(topup_balance_extra(-1.0, Some((0.04, "CNY"))).is_none());
        assert!(topup_balance_extra(f64::NAN, None).is_none());
    }

    /// credits = 50 → **有**该行，值按单价折算（无单价则原样 credits）
    #[test]
    fn test_topup_extra_shown_when_positive() {
        let kv = topup_balance_extra(50.0, Some((0.04, "CNY"))).expect("余额 > 0 应产出");
        assert_eq!(kv.key, "充值余额");
        assert_eq!(kv.value, "2.00 CNY");

        let kv = topup_balance_extra(50.0, None).expect("余额 > 0 应产出");
        assert_eq!(kv.key, "充值余额");
        assert_eq!(kv.value, "50 credits");
    }

    /// 字段缺失（含「只有充值限额」）→ **不产出**该行（走与生产一致的组合链路）
    #[test]
    fn test_topup_extra_absent_when_field_missing() {
        for data in [
            json!({}),
            json!({ "max_topup": { "cny_fen": 100000 }, "min_topup": { "cny_fen": 1000 } }),
            json!({ "daily_topup_limit_credits": 200000 }),
            json!({ "balance_credits": 0 }),
        ] {
            let extra =
                topup_credits(&data).and_then(|c| topup_balance_extra(c, credit_price(&data)));
            assert!(extra.is_none(), "不应产出「充值余额」行: {data}");
        }

        // 有余额时的完整链路：5000 credits × 0.04 = 200.00 CNY
        let data = json!({
            "balance_credits": 5000,
            "credit_unit_prices": { "cny_fen_per_million": 40000 }
        });
        let extra = topup_credits(&data)
            .and_then(|c| topup_balance_extra(c, credit_price(&data)))
            .expect("有余额应产出");
        assert_eq!(extra.key, "充值余额");
        assert_eq!(extra.value, "200.00 CNY");
    }
}

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
        let pid = match p.get("id").and_then(|i| i.as_i64()) {
            Some(id) => id,
            None => continue,
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
                let credits = lookup_number(&d, "balance_credits");
                let price = credit_price(&d);
                match (credits, price) {
                    (Some(c), Some((per_credit, currency))) => {
                        let amount = c * per_credit;
                        has_wallet = true;
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

        // 订阅窗口（5h / 7d）→ 结构化配额窗口（参照 Mac 版：优先订阅源，percentage ?? utilization）
        if let Ok(usage) = http::send_json(
            client,
            "GET",
            &format!("{base}/api/v1/projects/{pid}/subscription/usage"),
            &[("Authorization", auth_value.clone())],
            None,
        )
        .await
        {
            let data = usage.get("data").cloned().unwrap_or(usage.clone());
            let windows = data
                .get("windows")
                .and_then(|w| w.as_array())
                .cloned()
                .unwrap_or_else(|| {
                    // 部分版本直接返回窗口数组
                    data.as_array().cloned().unwrap_or_default()
                });
            for w in windows {
                let window = w.get("window").and_then(|x| x.as_str()).unwrap_or("?");
                let pct = w
                    .get("used_percent")
                    .and_then(|x| x.as_f64())
                    .or_else(|| w.get("percentage").and_then(|x| x.as_f64()))
                    .or_else(|| w.get("utilization").and_then(|x| x.as_f64()));
                let label = match window {
                    "five_hour" => "5h",
                    "seven_day" => "7d",
                    other => other,
                };
                if let Some(p) = pct {
                    info.extras.push(KeyValue {
                        key: format!("{label} 窗口"),
                        value: format!("{p:.0}%"),
                    });
                    info.quota_windows.push(crate::types::QuotaWindow {
                        window: Some(label.to_string()),
                        used_percent: Some(p),
                        resets_at: w
                            .get("resets_at")
                            .and_then(|r| r.as_str())
                            .map(String::from),
                    });
                }
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
        // 有 credits 但没有可折算的单价：展示原始值
        let shown = credits_without_price
            .iter()
            .map(|(name, c)| {
                if name.is_empty() {
                    format!("{c:.0} credits")
                } else {
                    format!("{name}: {c:.0}")
                }
            })
            .collect::<Vec<_>>()
            .join("、");
        info.extras.push(KeyValue {
            key: "钱包 credits".into(),
            value: shown,
        });
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

#[cfg(test)]
mod tests {
    use super::{credit_price, normalize_base};
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
}

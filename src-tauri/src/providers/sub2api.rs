//! sub2api（Wei-Shaw/sub2api）适配器
//!
//! 凭证优先级：
//! 1. API Key（sk-）→ GET {base}/v1/usage —— 裸 JSON，一次拿全余额/key 额度/窗口用量
//! 2. 用户名+密码 → POST /api/v1/auth/login 换 JWT（轮转出新的 access/refresh token 会回写配置）
//! 3. access token（+可选 refresh token 自动续期）→ GET /api/v1/auth/me + /api/v1/usage/dashboard/stats
//!
//! 金额单位：全部为美元（USD）浮点数。

use crate::http;
use crate::jsonpath::{lookup_number, lookup_string};
use crate::types::{AccountConfig, AccountInfo, KeyValue, Money, QuotaWindow};
use serde_json::{json, Value};

pub async fn fetch(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    if !acc.api_key.is_empty() {
        fetch_with_api_key(client, acc).await
    } else if !acc.username.is_empty() && !acc.password.is_empty() {
        fetch_with_password(client, acc).await
    } else if !acc.token.is_empty() || !acc.refresh_token.is_empty() {
        fetch_with_token(client, acc).await
    } else {
        Err("需要填写 API Key、或用户名+密码、或访问令牌".into())
    }
}

/// GET /v1/usage（API key，裸 JSON）
async fn fetch_with_api_key(
    client: &reqwest::Client,
    acc: &AccountConfig,
) -> Result<AccountInfo, String> {
    let base = acc.base();
    let url = format!("{base}/v1/usage");
    let (hk, hv) = http::bearer(&acc.api_key);
    let v = http::send_json(client, "GET", &url, &[(hk.as_str(), hv)], None).await?;

    let mut info = AccountInfo {
        raw: Some(v.clone()),
        fetched_at: crate::types::now_iso(),
        ..Default::default()
    };

    let mode = lookup_string(&v, "mode").unwrap_or_default();
    match mode.as_str() {
        "quota_limited" => {
            let (bal, used, total, extras) = parse_quota_limited(&v);
            info.balance = bal;
            info.used = used;
            info.total = total;
            info.extras.extend(extras);
        }
        "unrestricted" => {
            let (bal, extras) = parse_unrestricted(&v);
            info.balance = bal;
            info.extras.extend(extras);
            // R23：订阅数字限额（日/周/月 上限+用量）→ 结构化配额窗口
            info.quota_windows.extend(subscription_quota_windows(&v));
        }
        other => {
            // 兼容无 mode 字段的旧版本/fork：先按 quota 结构解析，拿不到再按钱包/订阅结构解析
            let (bal, used, total, extras) = parse_quota_limited(&v);
            if bal.is_some() {
                info.balance = bal;
                info.used = used;
                info.total = total;
                info.extras.extend(extras);
            } else {
                let (bal2, extras2) = parse_unrestricted(&v);
                info.balance = bal2;
                info.extras.extend(extras2);
                // R23：同上（legacy fork 也带 subscription 结构）
                info.quota_windows.extend(subscription_quota_windows(&v));
                if info.balance.is_none() && info.extras.is_empty() {
                    return Err(format!(
                        "无法解析 /v1/usage 响应（mode={other:?}），请确认站点是 sub2api；可在卡片里展开「原始数据」查看响应"
                    ));
                }
            }
        }
    }

    // 窗口速率限制（quota_limited）→ 结构化配额窗口
    if let Some(limits) = v.get("rate_limits").and_then(|r| r.as_array()) {
        for l in limits.iter().take(3) {
            let window = l.get("window").and_then(|w| w.as_str()).unwrap_or("?");
            let used = l.get("used").and_then(|u| u.as_f64()).unwrap_or(0.0);
            let limit = l.get("limit").and_then(|u| u.as_f64()).unwrap_or(0.0);
            if limit > 0.0 {
                info.extras.push(KeyValue {
                    key: format!("{window} 窗口"),
                    value: format!("{used:.2} / {limit:.2} USD"),
                });
                info.quota_windows.push(crate::types::QuotaWindow {
                    window: Some(normalize_window_name(window)),
                    used_percent: Some((used / limit * 100.0).min(100.0)),
                    resets_at: l.get("reset_at").and_then(|r| r.as_str()).map(String::from),
                    ..Default::default()
                });
            }
        }
    }

    // 按日用量（统计图）
    if let Some(days) = v.get("daily_usage").and_then(|d| d.as_array()) {
        for d in days {
            info.daily_usage.push(crate::types::UsagePoint {
                date: lookup_string(d, "date"),
                requests: crate::jsonpath::lookup_i64(d, "requests"),
                input_tokens: lookup_number(d, "input_tokens"),
                output_tokens: lookup_number(d, "output_tokens"),
                tokens: lookup_number(d, "total_tokens"),
                cost: lookup_number(d, "actual_cost").or_else(|| lookup_number(d, "cost")),
                cost_unit: Some("USD".into()),
                latency_ms: None,
                model: None,
            });
        }
    }

    // 按模型用量（统计图）
    if let Some(models) = v.get("model_stats").and_then(|d| d.as_array()) {
        for m in models {
            info.model_usage.push(crate::types::UsagePoint {
                model: lookup_string(m, "model"),
                requests: crate::jsonpath::lookup_i64(m, "requests"),
                input_tokens: lookup_number(m, "input_tokens"),
                output_tokens: lookup_number(m, "output_tokens"),
                tokens: lookup_number(m, "total_tokens"),
                cost: lookup_number(m, "actual_cost").or_else(|| lookup_number(m, "cost")),
                cost_unit: Some("USD".into()),
                latency_ms: None,
                date: None,
            });
        }
    }

    // 今日 / 累计用量
    if let Some(reqs) = lookup_number(&v, "usage.today.requests") {
        info.requests = Some(reqs as i64);
    }
    if let Some(cost) = lookup_number(&v, "usage.today.actual_cost") {
        info.extras.push(KeyValue {
            key: "今日花费".into(),
            value: format!("{cost:.4} USD"),
        });
    }
    if let Some(cost) = lookup_number(&v, "usage.total.actual_cost") {
        info.extras.push(KeyValue {
            key: "累计花费".into(),
            value: format!("{cost:.4} USD"),
        });
    }

    Ok(info)
}

/// 窗口名归一化（5h / 1d / 7d → 统一展示用标签）
fn normalize_window_name(w: &str) -> String {
    match w {
        "5h" | "five_hour" => "5h".into(),
        "1d" | "one_day" => "1d".into(),
        "7d" | "seven_day" => "7d".into(),
        other => other.to_string(),
    }
}

/// quota_limited 模式解析：key 配了额度/速率限制
/// 返回 (余额, 已用, 总额度, 附加行)
fn parse_quota_limited(v: &Value) -> (Option<Money>, Option<Money>, Option<Money>, Vec<KeyValue>) {
    let mut extras = Vec::new();
    let remaining = lookup_number(v, "quota.remaining").or_else(|| lookup_number(v, "remaining"));
    let used = lookup_number(v, "quota.used");
    let limit = lookup_number(v, "quota.limit");
    if let Some(status) = lookup_string(v, "status") {
        extras.push(KeyValue {
            key: "Key 状态".into(),
            value: status,
        });
    }
    if let Some(d) = lookup_number(v, "days_until_expiry") {
        extras.push(KeyValue {
            key: "Key 剩余天数".into(),
            value: format!("{d:.0}"),
        });
    }
    let usd = || "USD".to_string();
    (
        remaining.map(|r| Money {
            amount: r,
            currency: usd(),
        }),
        used.map(|u| Money {
            amount: u,
            currency: usd(),
        }),
        limit.filter(|l| *l > 0.0).map(|l| Money {
            amount: l,
            currency: usd(),
        }),
        extras,
    )
}

/// unrestricted 模式解析：钱包（balance）或订阅（subscription）
/// 返回 (余额, 附加行)
fn parse_unrestricted(v: &Value) -> (Option<Money>, Vec<KeyValue>) {
    let mut extras = Vec::new();
    // 钱包模式：balance 字段；订阅模式：remaining
    let balance = lookup_number(v, "balance")
        .or_else(|| lookup_number(v, "remaining"))
        .map(|b| Money {
            amount: b,
            currency: "USD".into(),
        });
    if let Some(plan) = lookup_string(v, "planName") {
        extras.push(KeyValue {
            key: "计划".into(),
            value: plan,
        });
    }
    if let Some(sub) = v.get("subscription") {
        for (label, path) in [
            ("日用量", "daily_usage_usd"),
            ("周用量", "weekly_usage_usd"),
            ("月用量", "monthly_usage_usd"),
        ] {
            if let Some(n) = lookup_number(sub, path) {
                extras.push(KeyValue {
                    key: label.to_string(),
                    value: format!("{n:.2} USD"),
                });
            }
        }
        for (label, path) in [
            ("日上限", "daily_limit_usd"),
            ("周上限", "weekly_limit_usd"),
            ("月上限", "monthly_limit_usd"),
        ] {
            if let Some(n) = lookup_number(sub, path).filter(|l| *l > 0.0) {
                extras.push(KeyValue {
                    key: label.to_string(),
                    value: format!("{n:.2} USD"),
                });
            }
        }
    }
    (balance, extras)
}

/// R23：把 `subscription.{daily,weekly,monthly}_{usage,limit}_usd` 数字限额转成结构化配额窗口。
///
/// 规则（纯函数，便于单测）：
/// - usage 与 limit **成对存在**且 limit > 0 才产出（usage 为 0 合法 → 已用 0%）；
/// - `used_percent` 保留**真实比值**（超限 >100 不钳制——超限是重要事实；钳制是显示层职责）；
/// - `resets_at` 为 None：站点时区/重置规则未知，不编造倒计时；
/// - 窗口标签用 1d / 7d / 1m（与 Kimi 的 5h/7d 同一语言）。
pub fn subscription_quota_windows(v: &Value) -> Vec<QuotaWindow> {
    let Some(sub) = v.get("subscription") else {
        return Vec::new();
    };
    let usd = || "USD".to_string();
    let mut out = Vec::new();
    for (label, usage_key, limit_key) in [
        ("1d", "daily_usage_usd", "daily_limit_usd"),
        ("7d", "weekly_usage_usd", "weekly_limit_usd"),
        ("1m", "monthly_usage_usd", "monthly_limit_usd"),
    ] {
        let (Some(usage), Some(limit)) = (
            lookup_number(sub, usage_key),
            lookup_number(sub, limit_key).filter(|l| *l > 0.0),
        ) else {
            continue;
        };
        out.push(QuotaWindow {
            window: Some(label.into()),
            used_percent: Some(usage / limit * 100.0),
            resets_at: None,
            used_amount: Some(Money {
                amount: usage,
                currency: usd(),
            }),
            limit_amount: Some(Money {
                amount: limit,
                currency: usd(),
            }),
        });
    }
    out
}

/// 邮箱+密码登录（信封 {code:0, data}），成功后回写轮转的 token
async fn fetch_with_password(
    client: &reqwest::Client,
    acc: &AccountConfig,
) -> Result<AccountInfo, String> {
    let base = acc.base();
    let url = format!("{base}/api/v1/auth/login");
    let body = json!({ "email": acc.username, "password": acc.password }).to_string();
    let v = http::send_json(client, "POST", &url, &[], Some(&body)).await?;

    // 2FA / 验证码情形
    if v.get("requires_2fa")
        .and_then(|r| r.as_bool())
        .unwrap_or(false)
    {
        return Err("该站点开启了两步验证（2FA），暂不支持自动登录；请改用 API Key 查询".into());
    }
    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
    if code != 0 {
        let msg = v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("登录失败");
        return Err(format!("登录失败: {msg}"));
    }
    let data = v.get("data").ok_or("登录响应缺少 data")?;
    let access = lookup_string(data, "access_token").ok_or("登录响应缺少 access_token")?;
    let refresh = lookup_string(data, "refresh_token").unwrap_or_default();
    let user = data.get("user").cloned().unwrap_or(Value::Null);

    let mut info = AccountInfo {
        new_token: Some(access.clone()),
        new_refresh_token: if refresh.is_empty() {
            None
        } else {
            Some(refresh)
        },
        fetched_at: crate::types::now_iso(),
        ..Default::default()
    };
    if let Some(bal) = lookup_number(&user, "balance") {
        info.balance = Some(Money {
            amount: bal,
            currency: "USD".into(),
        });
    }
    if let Some(u) = lookup_string(&user, "username") {
        info.note = Some(format!("已登录：{u}"));
    }

    // 面板统计（今日请求数 / 今日花费 / 累计花费）
    let (requests, today_cost, total_cost) = panel_stats(client, &base, &access).await;
    if let Some(r) = requests {
        info.requests = Some(r);
    }
    if let Some(c) = today_cost {
        info.extras.push(KeyValue {
            key: "今日花费".into(),
            value: format!("{c:.4} USD"),
        });
    }
    if let Some(c) = total_cost {
        info.used = Some(Money {
            amount: c,
            currency: "USD".into(),
        });
    }
    Ok(info)
}

/// 面板用量统计：兼容两个版本的端点
/// - /api/v1/usage/dashboard/stats（字段 today.requests / today.actual_cost / total.actual_cost）
/// - /api/v1/usage/stats?period=today（字段 total_requests / total_actual_cost，all-api-hub 验证过）
///
/// 返回 (今日请求数, 今日花费 USD, 累计花费 USD)
async fn panel_stats(
    client: &reqwest::Client,
    base: &str,
    access: &str,
) -> (Option<i64>, Option<f64>, Option<f64>) {
    let mut requests: Option<i64> = None;
    let mut today_cost: Option<f64> = None;
    let mut total_cost: Option<f64> = None;
    let auth = ("Authorization", format!("Bearer {access}"));

    if let Ok(stats) = http::send_json(
        client,
        "GET",
        &format!("{base}/api/v1/usage/dashboard/stats"),
        std::slice::from_ref(&auth),
        None,
    )
    .await
    {
        let d = stats.get("data").cloned().unwrap_or(Value::Null);
        requests = crate::jsonpath::lookup_i64(&d, "today.requests")
            .or_else(|| crate::jsonpath::lookup_i64(&d, "today.total_requests"))
            .or(requests);
        today_cost = lookup_number(&d, "today.actual_cost")
            .or_else(|| lookup_number(&d, "today.cost"))
            .or(today_cost);
        total_cost = lookup_number(&d, "total.actual_cost")
            .or_else(|| lookup_number(&d, "total.cost"))
            .or(total_cost);
    }

    // 回退端点（period=today 的 total_* 即今日数据）
    if requests.is_none() || today_cost.is_none() {
        if let Ok(stats) = http::send_json(
            client,
            "GET",
            &format!("{base}/api/v1/usage/stats?period=today"),
            &[auth],
            None,
        )
        .await
        {
            let d = stats.get("data").cloned().unwrap_or(Value::Null);
            requests = crate::jsonpath::lookup_i64(&d, "total_requests").or(requests);
            today_cost = lookup_number(&d, "total_actual_cost").or(today_cost);
        }
    }
    (requests, today_cost, total_cost)
}

/// 已有 token（可选用 refresh token 续期）
async fn fetch_with_token(
    client: &reqwest::Client,
    acc: &AccountConfig,
) -> Result<AccountInfo, String> {
    let base = acc.base();
    let mut access = acc.token.clone();
    let mut new_refresh: Option<String> = None;
    let mut new_access: Option<String> = None;

    // 无 access token 或已失效时，用 refresh token 换新
    if access.is_empty() && !acc.refresh_token.is_empty() {
        let (a, r) = refresh_login(client, &base, &acc.refresh_token).await?;
        access = a.clone();
        new_access = Some(a);
        new_refresh = Some(r);
    }

    let me_url = format!("{base}/api/v1/auth/me");
    let result = http::send_json(
        client,
        "GET",
        &me_url,
        &[("Authorization", format!("Bearer {access}"))],
        None,
    )
    .await;

    let v = match result {
        Ok(v) => v,
        Err(e) => {
            // 无 refresh token 时直接报错
            if acc.refresh_token.is_empty() {
                return Err(format!(
                    "{e}（token 可能已过期，请填写 refresh_token 或重新登录）"
                ));
            }
            // 有 refresh token：续期后重试一次
            let (a, r) = match refresh_login(client, &base, &acc.refresh_token).await {
                Ok(pair) => pair,
                Err(_) => return Err(e),
            };
            new_access = Some(a.clone());
            new_refresh = Some(r);
            http::send_json(
                client,
                "GET",
                &me_url,
                &[("Authorization", format!("Bearer {a}"))],
                None,
            )
            .await?
        }
    };

    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let mut info = AccountInfo {
        balance: lookup_number(&data, "balance").map(|b| Money {
            amount: b,
            currency: "USD".into(),
        }),
        note: lookup_string(&data, "username").map(|u| format!("已登录：{u}")),
        new_token: new_access,
        new_refresh_token: new_refresh,
        fetched_at: crate::types::now_iso(),
        ..Default::default()
    };
    if let Some(fb) = lookup_number(&data, "frozen_balance").filter(|f| *f > 0.0) {
        info.extras.push(KeyValue {
            key: "冻结余额".into(),
            value: format!("{fb:.2} USD"),
        });
    }

    // 面板统计
    let (requests, today_cost, total_cost) = panel_stats(client, &base, &access).await;
    if let Some(r) = requests {
        info.requests = Some(r);
    }
    if let Some(c) = today_cost {
        info.extras.push(KeyValue {
            key: "今日花费".into(),
            value: format!("{c:.4} USD"),
        });
    }
    if let Some(c) = total_cost {
        info.used = Some(Money {
            amount: c,
            currency: "USD".into(),
        });
    }
    Ok(info)
}

async fn refresh_login(
    client: &reqwest::Client,
    base: &str,
    refresh_token: &str,
) -> Result<(String, String), String> {
    let url = format!("{base}/api/v1/auth/refresh");
    let body = json!({ "refresh_token": refresh_token }).to_string();
    let v = http::send_json(client, "POST", &url, &[], Some(&body)).await?;
    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(0);
    if code != 0 {
        let msg = v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("refresh 失败");
        return Err(format!("刷新令牌失败: {msg}"));
    }
    let data = v.get("data").ok_or("refresh 响应缺少 data")?;
    let access = lookup_string(data, "access_token").ok_or("refresh 响应缺少 access_token")?;
    let refresh = lookup_string(data, "refresh_token").ok_or("refresh 响应缺少 refresh_token")?;
    Ok((access, refresh))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 源码调研报告里 quota_limited 模式的响应结构（Wei-Shaw/sub2api gateway_handler.go）
    #[test]
    fn test_parse_quota_limited() {
        let v = json!({
            "mode": "quota_limited",
            "status": "active",
            "quota": { "limit": 10.0, "used": 3.5, "remaining": 6.5, "unit": "USD" },
            "remaining": 6.5,
            "days_until_expiry": 42,
            "usage": { "today": { "requests": 17, "actual_cost": 0.1234 } }
        });
        let (bal, used, total, extras) = parse_quota_limited(&v);
        assert_eq!(bal.as_ref().unwrap().amount, 6.5);
        assert_eq!(used.as_ref().unwrap().amount, 3.5);
        assert_eq!(total.as_ref().unwrap().amount, 10.0);
        assert!(extras
            .iter()
            .any(|e| e.key == "Key 状态" && e.value == "active"));
        assert!(extras
            .iter()
            .any(|e| e.key == "Key 剩余天数" && e.value == "42"));
    }

    /// 钱包（unrestricted）模式：balance 字段
    #[test]
    fn test_parse_unrestricted_wallet() {
        let v = json!({
            "mode": "unrestricted",
            "planName": "钱包余额",
            "balance": 12.34,
            "unit": "USD",
            "subscription": { "daily_usage_usd": 1.5, "monthly_limit_usd": 30.0 }
        });
        let (bal, extras) = parse_unrestricted(&v);
        assert_eq!(bal.as_ref().unwrap().amount, 12.34);
        assert_eq!(bal.as_ref().unwrap().currency, "USD");
        assert!(extras
            .iter()
            .any(|e| e.key == "计划" && e.value == "钱包余额"));
        assert!(extras
            .iter()
            .any(|e| e.key == "日用量" && e.value == "1.50 USD"));
        assert!(extras
            .iter()
            .any(|e| e.key == "月上限" && e.value == "30.00 USD"));
    }

    /// 订阅（unrestricted）模式：remaining + subscription 字段，无 balance
    #[test]
    fn test_parse_unrestricted_subscription() {
        let v = json!({
            "mode": "unrestricted",
            "planName": "Claude Max",
            "remaining": 0.75,
            "subscription": { "weekly_usage_usd": 5.25, "weekly_limit_usd": 40.0 }
        });
        let (bal, extras) = parse_unrestricted(&v);
        assert_eq!(bal.as_ref().unwrap().amount, 0.75);
        assert!(extras
            .iter()
            .any(|e| e.key == "周用量" && e.value == "5.25 USD"));
    }

    // ---------- R23：数字限额 → 结构化配额窗口 ----------

    /// 完整三对（bosc 真实形态）：1d/7d/1m 全产出，百分比 = 用量/上限 真实比值
    #[test]
    fn test_subscription_quota_windows_full_set() {
        let v = json!({
            "subscription": {
                "daily_usage_usd": 1.5, "daily_limit_usd": 10.0,
                "weekly_usage_usd": 5.25, "weekly_limit_usd": 40.0,
                "monthly_usage_usd": 21.0, "monthly_limit_usd": 100.0
            }
        });
        let ws = subscription_quota_windows(&v);
        assert_eq!(ws.len(), 3, "三对齐全应产出三个窗口");
        assert_eq!(ws[0].window.as_deref(), Some("1d"));
        assert_eq!(ws[1].window.as_deref(), Some("7d"));
        assert_eq!(ws[2].window.as_deref(), Some("1m"));
        assert!((ws[0].used_percent.unwrap() - 15.0).abs() < 1e-9);
        assert!((ws[1].used_percent.unwrap() - 13.125).abs() < 1e-9);
        assert!((ws[2].used_percent.unwrap() - 21.0).abs() < 1e-9);
        // 原始金额随窗口携带（raw 显示模式的数据源）
        assert_eq!(ws[0].used_amount.as_ref().unwrap().amount, 1.5);
        assert_eq!(ws[0].limit_amount.as_ref().unwrap().amount, 10.0);
        assert_eq!(ws[0].limit_amount.as_ref().unwrap().currency, "USD");
        // 站点时区未知：不编造重置时间
        assert!(ws.iter().all(|w| w.resets_at.is_none()));
    }

    /// 超限保留真实值（bosc 日用量 201.79 / 上限 200 → 100.895%，**不得**钳制吃掉超限事实）
    #[test]
    fn test_subscription_quota_windows_keeps_over_limit_ratio() {
        let v = json!({
            "subscription": { "daily_usage_usd": 201.79, "daily_limit_usd": 200.0 }
        });
        let ws = subscription_quota_windows(&v);
        assert_eq!(ws.len(), 1);
        let pct = ws[0].used_percent.unwrap();
        assert!((pct - 100.895).abs() < 1e-9, "超限比值必须保留: {pct}");
        assert!(pct > 100.0);
    }

    /// limit ≤ 0 / 缺 usage / 无 subscription：一律不产出（不编造窗口）
    #[test]
    fn test_subscription_quota_windows_skips_incomplete_pairs() {
        // limit = 0（无上限 = 不限）
        let v = json!({ "subscription": { "daily_usage_usd": 1.5, "daily_limit_usd": 0.0 } });
        assert!(subscription_quota_windows(&v).is_empty());
        // 缺 usage
        let v = json!({ "subscription": { "daily_limit_usd": 10.0 } });
        assert!(subscription_quota_windows(&v).is_empty());
        // 只有 usage 没有 limit（无法算百分比）
        let v = json!({ "subscription": { "daily_usage_usd": 1.5 } });
        assert!(subscription_quota_windows(&v).is_empty());
        // 无 subscription
        let v = json!({ "balance": 1.0 });
        assert!(subscription_quota_windows(&v).is_empty());
        // 部分成对：只产出成对的窗口
        let v = json!({
            "subscription": { "daily_usage_usd": 1.5, "daily_limit_usd": 10.0, "weekly_usage_usd": 5.0 }
        });
        let ws = subscription_quota_windows(&v);
        assert_eq!(ws.len(), 1);
        assert_eq!(ws[0].window.as_deref(), Some("1d"));
    }
}

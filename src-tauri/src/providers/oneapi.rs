//! one-api / new-api 系面板适配器
//!
//! 两条路径（按可用凭证自动选择）：
//! 1. 访问令牌 token → GET /api/user/self（信封 {success, message, data}，data 内 quota/used_quota 为内部点数，
//!    默认 500000 点 = 1 美元；多种面板需要带用户 ID 兼容头）+ GET /api/log/self/stat（今日消费）
//! 2. API Key → GET /v1/dashboard/billing/subscription（hard_limit_usd）+ GET /v1/dashboard/billing/usage
//!    （total_usage，单位美分）

use crate::http;
use crate::jsonpath::{lookup_i64, lookup_number};
use crate::types::{AccountConfig, AccountInfo, KeyValue, Money};
use reqwest::RequestBuilder;
use serde_json::Value;

pub async fn fetch(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    if !acc.token.is_empty() {
        fetch_with_token(client, acc).await
    } else if !acc.api_key.is_empty() {
        fetch_with_api_key(client, acc).await
    } else {
        Err("需要填写访问令牌（token）或 API Key 之一".into())
    }
}

/// 给请求加上用户 ID 兼容头扇出（不同面板认不同的头）
fn add_user_headers(mut req: RequestBuilder, acc: &AccountConfig) -> RequestBuilder {
    if let Some(uid) = acc.user_id {
        let ids = [uid.to_string(), acc.username.clone()];
        let id = ids
            .iter()
            .find(|s| !s.is_empty())
            .cloned()
            .unwrap_or_default();
        if !id.is_empty() {
            for h in [
                "New-API-User",
                "Veloera-User",
                "X-Api-User",
                "voapi-user",
                "User-id",
                "Rix-Api-User",
                "neo-api-user",
                "X-ModelFlare-User",
            ] {
                // Rix-Api-User 只接受纯数字
                if h == "Rix-Api-User" && !id.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                req = req.header(h, &id);
            }
        }
    }
    req
}

async fn fetch_with_token(
    client: &reqwest::Client,
    acc: &AccountConfig,
) -> Result<AccountInfo, String> {
    let base = acc.base();
    let url = format!("{base}/api/user/self");
    let (hk, hv) = http::bearer(&acc.token);
    let mut req = client.get(&url).header(&hk, &hv);
    req = add_user_headers(req, acc);
    let resp = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("响应解析失败: {e}"))?;
    if !status.is_success() {
        let msg = v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("查询失败");
        return Err(format!("HTTP {status}: {msg}"));
    }
    let success = v.get("success").and_then(|s| s.as_bool()).unwrap_or(true);
    if !success {
        let msg = v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("未知错误");
        return Err(format!("站点返回失败: {msg}"));
    }
    let data = v.get("data").ok_or("响应缺少 data 字段")?;

    let per = acc.quota_per_unit_value();
    let quota = lookup_number(data, "quota").unwrap_or(0.0);
    let used_quota = lookup_number(data, "used_quota").unwrap_or(0.0);
    let requests = lookup_i64(data, "request_count");

    let mut info = AccountInfo {
        balance: Some(Money {
            amount: quota / per,
            currency: "USD".into(),
        }),
        used: Some(Money {
            amount: used_quota / per,
            currency: "USD".into(),
        }),
        total: None,
        requests,
        note: None,
        extras: Vec::new(),
        raw: Some(v.clone()),
        fetched_at: crate::types::now_iso(),
        new_token: None,
        new_refresh_token: None,
    };

    // 今日消费（快路径 /api/log/self/stat，失败则静默跳过）
    if let Some(today) = fetch_today_usage(client, acc).await {
        info.extras.push(KeyValue {
            key: "今日消费".into(),
            value: format!("{:.4} USD", today / per),
        });
    }

    // 一些分支（Veloera 等）带返利额度等字段，尽量展示
    if let Some(n) = lookup_number(data, "aff_quota") {
        info.extras.push(KeyValue {
            key: "返利额度".into(),
            value: format!("{:.2}", n / per),
        });
    }
    Ok(info)
}

/// GET /api/log/self/stat（今日 0 点 → 现在，type=2 消费）
async fn fetch_today_usage(client: &reqwest::Client, acc: &AccountConfig) -> Option<f64> {
    let base = acc.base();
    let now = chrono::Local::now();
    let today_start = now
        .with_time(chrono::NaiveTime::from_hms_opt(0, 0, 0)?)
        .single()?
        .timestamp();
    let url = format!(
        "{base}/api/log/self/stat?p=1&page_size=100&token_name=&model_name=&start_timestamp={today_start}&end_timestamp={}&type=2&group=",
        now.timestamp()
    );
    let (hk, hv) = http::bearer(&acc.token);
    let mut req = client.get(&url).header(&hk, &hv);
    req = add_user_headers(req, acc);
    let v: Value = req.send().await.ok()?.json().await.ok()?;
    let ok = v.get("success").and_then(|s| s.as_bool()).unwrap_or(true);
    if !ok {
        return None;
    }
    lookup_number(&v, "data.quota").filter(|q| *q > 0.0)
}

async fn fetch_with_api_key(
    client: &reqwest::Client,
    acc: &AccountConfig,
) -> Result<AccountInfo, String> {
    let base = acc.base();
    let (hk, hv) = http::bearer(&acc.api_key);

    // 订阅信息：hard_limit_usd
    let sub: Value = client
        .get(format!("{base}/v1/dashboard/billing/subscription"))
        .header(&hk, &hv)
        .send()
        .await
        .map_err(|e| format!("查询订阅失败: {e}"))?
        .json()
        .await
        .map_err(|e| format!("订阅响应解析失败: {e}"))?;

    let hard_limit = lookup_number(&sub, "hard_limit_usd");

    // 用量：本月 1 号 → 明天（end_date 的包含语义在不同实现有差异，传明天在两种语义下都安全：
    // 若为「含当日」则明天尚无数据，若为「不含当日」则恰好覆盖今天）
    let now = chrono::Local::now();
    let tomorrow = (now + chrono::Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    let month_start = now.format("%Y-%m-01").to_string();
    let usage: Value = client
        .get(format!(
            "{base}/v1/dashboard/billing/usage?start_date={month_start}&end_date={tomorrow}"
        ))
        .header(&hk, &hv)
        .send()
        .await
        .map_err(|e| format!("查询用量失败: {e}"))?
        .json()
        .await
        .map_err(|e| format!("用量响应解析失败: {e}"))?;

    let total_usage_usd = lookup_number(&usage, "total_usage").map(|c| c / 100.0);

    let balance = hard_limit.zip(total_usage_usd).map(|(limit, used)| Money {
        amount: (limit - used).max(0.0),
        currency: "USD".into(),
    });

    Ok(AccountInfo {
        balance,
        used: total_usage_usd.map(|u| Money {
            amount: u,
            currency: "USD".into(),
        }),
        total: hard_limit.map(|l| Money {
            amount: l,
            currency: "USD".into(),
        }),
        requests: None,
        note: Some("基于 API Key 的计费接口（本月用量）".into()),
        extras: Vec::new(),
        raw: Some(usage),
        fetched_at: crate::types::now_iso(),
        new_token: None,
        new_refresh_token: None,
    })
}

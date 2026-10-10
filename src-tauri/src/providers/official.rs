//! 官方提供商适配器：DeepSeek / OpenAI / SiliconFlow / Moonshot / 智谱 / 百炼
//!
//! - DeepSeek: GET /user/balance（官方，CNY/USD，balance_infos[0]，字符串金额）
//! - OpenAI:   GET /v1/organization/costs（本月成本，需要 Admin key；官方无余额端点）
//! - SiliconFlow: GET /v1/user/info（code=20000 成功；totalBalance=总余额；币种按域名推断）
//! - Moonshot: GET /v1/users/me/balance（官方，code=0；.cn=CNY / .ai=USD）
//! - 智谱:     控制台内部接口 GET /api/biz/account/query-customer-account-report（裸 key 不带 Bearer；
//!   HTTP 200 不代表成功要看 body code；降级 /api/paas/v4/balance）
//! - 百炼:     官方无 sk- key 余额接口（需要 RAM AK/SK 走 BSS OpenAPI，暂不支持）

use crate::http;
use crate::jsonpath::{lookup_number, lookup_string};
use crate::types::{AccountConfig, AccountInfo, KeyValue, Money, ProviderKind};
use chrono::Datelike;
use serde_json::Value;

pub async fn fetch(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    match acc.kind {
        ProviderKind::DeepSeek => deepseek(client, acc).await,
        ProviderKind::OpenAi => openai(client, acc).await,
        ProviderKind::SiliconFlow => siliconflow(client, acc).await,
        ProviderKind::Moonshot => moonshot(client, acc).await,
        ProviderKind::Zhipu => zhipu(client, acc).await,
        ProviderKind::DashScope => unsupported(
            "阿里云百炼的 sk- key 无法查询余额（计费在阿里云主账号，需要 RAM AK/SK 走 BSS OpenAPI 才能查，且是整个云账号的余额）。请在百炼控制台查看。",
        ),
        _ => Err("该类型暂不支持".into()),
    }
}

fn unsupported(msg: &str) -> Result<AccountInfo, String> {
    Err(msg.to_string())
}

/// URL 组件百分号编码（用于分页游标等不透明参数）
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::encode_uri_component;

    #[test]
    fn test_encode_uri_component() {
        assert_eq!(encode_uri_component("abc123-_."), "abc123-_.");
        // 空格、&、=、+ 等会被编码
        assert_eq!(encode_uri_component("a b"), "a%20b");
        assert_eq!(encode_uri_component("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_uri_component("pg+_cursor/"), "pg%2B_cursor%2F");
        // 中文字节全部编码
        assert_eq!(encode_uri_component("密"), "%E5%AF%86");
    }
}

fn need_key(acc: &AccountConfig) -> Result<String, String> {
    if acc.api_key.trim().is_empty() {
        Err("需要填写 API Key".into())
    } else {
        Ok(acc.api_key.trim().to_string())
    }
}

/// 按域名推断币种：.cn → CNY，其余 → USD
fn currency_for(base: &str) -> String {
    if base.contains(".cn") {
        "CNY".into()
    } else {
        "USD".into()
    }
}

/// DeepSeek: GET {base}/user/balance
async fn deepseek(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let key = need_key(acc)?;
    let base = acc.base();
    let (hk, hv) = http::bearer(&key);
    let v = http::send_json(
        client,
        "GET",
        &format!("{base}/user/balance"),
        &[(hk.as_str(), hv)],
        None,
    )
    .await?;

    let mut info = AccountInfo {
        fetched_at: crate::types::now_iso(),
        raw: Some(v.clone()),
        ..Default::default()
    };
    if let Some(b) = lookup_number(&v, "balance_infos[0].total_balance") {
        let currency =
            lookup_string(&v, "balance_infos[0].currency").unwrap_or_else(|| "CNY".into());
        info.balance = Some(Money {
            amount: b,
            currency,
        });
    }
    if let Some(g) = lookup_number(&v, "balance_infos[0].granted_balance") {
        info.extras.push(KeyValue {
            key: "赠送余额".into(),
            value: format!("{g:.2}"),
        });
    }
    if let Some(t) = lookup_number(&v, "balance_infos[0].topped_up_balance") {
        info.extras.push(KeyValue {
            key: "充值余额".into(),
            value: format!("{t:.2}"),
        });
    }
    if let Some(available) = v.get("is_available").and_then(|a| a.as_bool()) {
        info.extras.push(KeyValue {
            key: "可用状态".into(),
            value: if available {
                "正常".into()
            } else {
                "欠费/不可用".into()
            },
        });
    }
    Ok(info)
}

/// SiliconFlow: GET {base}/v1/user/info（code=20000 成功）
async fn siliconflow(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let key = need_key(acc)?;
    let base = acc.base();
    let (hk, hv) = http::bearer(&key);
    let v = http::send_json(
        client,
        "GET",
        &format!("{base}/v1/user/info"),
        &[(hk.as_str(), hv)],
        None,
    )
    .await?;

    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 20000 {
        let msg = v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("查询失败");
        return Err(format!("SiliconFlow 返回错误（code={code}）: {msg}"));
    }
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let currency = currency_for(&base);

    // totalBalance=总余额（充值+赠送）；balance=赠送部分；chargeBalance=充值部分
    let total = lookup_number(&data, "totalBalance").or_else(|| {
        lookup_number(&data, "chargeBalance")
            .map(|c| c + lookup_number(&data, "balance").unwrap_or(0.0))
    });

    let mut info = AccountInfo {
        balance: total.map(|t| Money {
            amount: t,
            currency: currency.clone(),
        }),
        fetched_at: crate::types::now_iso(),
        raw: Some(v.clone()),
        ..Default::default()
    };
    if let Some(c) = lookup_number(&data, "chargeBalance") {
        info.extras.push(KeyValue {
            key: "充值余额".into(),
            value: format!("{c:.4} {currency}"),
        });
    }
    if let Some(b) = lookup_number(&data, "balance") {
        info.extras.push(KeyValue {
            key: "赠送余额".into(),
            value: format!("{b:.4} {currency}"),
        });
    }
    if let Some(s) = lookup_string(&data, "status") {
        info.extras.push(KeyValue {
            key: "账户状态".into(),
            value: s,
        });
    }
    Ok(info)
}

/// Moonshot/Kimi: GET {base}/v1/users/me/balance（code=0 成功）
async fn moonshot(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let key = need_key(acc)?;
    let base = acc.base();
    let (hk, hv) = http::bearer(&key);
    let v = http::send_json(
        client,
        "GET",
        &format!("{base}/v1/users/me/balance"),
        &[(hk.as_str(), hv)],
        None,
    )
    .await?;

    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        let msg = lookup_string(&v, "msg")
            .or_else(|| lookup_string(&v, "message"))
            .unwrap_or_else(|| "查询失败".into());
        return Err(format!("Moonshot 返回错误（code={code}）: {msg}"));
    }
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let currency = currency_for(&base);

    let mut info = AccountInfo {
        balance: lookup_number(&data, "available_balance").map(|b| Money {
            amount: b,
            currency: currency.clone(),
        }),
        fetched_at: crate::types::now_iso(),
        raw: Some(v.clone()),
        ..Default::default()
    };
    if let Some(c) = lookup_number(&data, "cash_balance") {
        info.extras.push(KeyValue {
            key: "现金余额".into(),
            value: format!("{c:.4} {currency}") + if c < 0.0 { "（欠费）" } else { "" },
        });
    }
    if let Some(c) = lookup_number(&data, "voucher_balance") {
        info.extras.push(KeyValue {
            key: "代金券".into(),
            value: format!("{c:.4} {currency}"),
        });
    }
    Ok(info)
}

/// 智谱 GLM：控制台内部接口（裸 key）→ 降级 /api/paas/v4/balance（Bearer）
async fn zhipu(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let key = need_key(acc)?;
    let base = acc.base();

    // 主路径：控制台报表接口（Authorization: <key>，不带 Bearer）
    let url = format!("{base}/api/biz/account/query-customer-account-report");
    let result =
        http::send_json(client, "GET", &url, &[("Authorization", key.clone())], None).await;

    match result {
        Ok(v) => {
            // HTTP 200 不代表成功，必须看 body
            let success = v.get("success").and_then(|s| s.as_bool()).unwrap_or(false);
            let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
            if !success && code != 200 {
                let msg = lookup_string(&v, "msg").unwrap_or_else(|| "查询失败".into());
                // 1001 通常是鉴权问题 → 提示
                if code == 1001 {
                    return Err(
                        "智谱接口鉴权失败（code=1001）: 请确认填的是 open.bigmodel.cn 的 API Key"
                            .to_string(),
                    );
                }
                return Err(format!("智谱返回错误（code={code}）: {msg}"));
            }
            let data = v.get("data").cloned().unwrap_or(Value::Null);
            let mut info = AccountInfo {
                balance: lookup_number(&data, "availableBalance")
                    .or_else(|| lookup_number(&data, "balance"))
                    .map(|b| Money {
                        amount: b,
                        currency: "CNY".into(),
                    }),
                used: lookup_number(&data, "totalSpendAmount").map(|s| Money {
                    amount: s,
                    currency: "CNY".into(),
                }),
                fetched_at: crate::types::now_iso(),
                raw: Some(v.clone()),
                ..Default::default()
            };
            if let Some(r) = lookup_number(&data, "rechargeAmount") {
                info.extras.push(KeyValue {
                    key: "累计充值".into(),
                    value: format!("{r:.2} CNY"),
                });
            }
            if let Some(g) = lookup_number(&data, "giveAmount") {
                info.extras.push(KeyValue {
                    key: "累计赠送".into(),
                    value: format!("{g:.2} CNY"),
                });
            }
            if let Some(f) = lookup_number(&data, "frozenBalance").filter(|f| *f > 0.0) {
                info.extras.push(KeyValue {
                    key: "冻结余额".into(),
                    value: format!("{f:.2} CNY"),
                });
            }
            info.note = Some("使用智谱控制台内部接口（非官方公开 API，接口变动风险自担）".into());
            Ok(info)
        }
        Err(primary_err) => {
            // 降级：旧版 /api/paas/v4/balance（Bearer；国内站可能 404）
            let (hk, hv) = http::bearer(&key);
            match http::send_json(
                client,
                "GET",
                &format!("{base}/api/paas/v4/balance"),
                &[(hk.as_str(), hv)],
                None,
            )
            .await
            {
                Ok(v) => {
                    let data = v.get("data").cloned().unwrap_or(Value::Null);
                    let balance = lookup_number(&data, "balance")
                        .or_else(|| lookup_number(&data, "availableBalance"))
                        .or_else(|| lookup_number(&v, "balance"));
                    match balance {
                        Some(b) => Ok(AccountInfo {
                            balance: Some(Money {
                                amount: b,
                                currency: "CNY".into(),
                            }),
                            note: Some("经由旧版余额接口查询".into()),
                            raw: Some(v),
                            fetched_at: crate::types::now_iso(),
                            ..Default::default()
                        }),
                        None => Err(primary_err),
                    }
                }
                Err(_) => Err(primary_err),
            }
        }
    }
}

/// OpenAI: GET {base}/v1/organization/costs（本月成本，分页累计；需要 Admin key）
async fn openai(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let key = need_key(acc)?;
    let base = acc.base();

    let now = chrono::Utc::now();
    let month_start =
        chrono::TimeZone::with_ymd_and_hms(&chrono::Utc, now.year(), now.month(), 1, 0, 0, 0)
            .single()
            .ok_or("计算月份失败")?;

    let mut total = 0.0;
    let mut page: Option<String> = None;
    let mut currency = "usd".to_string();
    let mut raw_sample: Option<Value> = None;

    for _ in 0..12 {
        let mut url = format!(
            "{base}/v1/organization/costs?start_time={}&end_time={}&limit=31",
            month_start.timestamp(),
            now.timestamp()
        );
        if let Some(p) = &page {
            // 分页游标是不透明字符串，必须做 URL 编码
            url.push_str(&format!("&page={}", encode_uri_component(p)));
        }
        let (hk, hv) = http::bearer(&key);
        let v = http::send_json(client, "GET", &url, &[(hk.as_str(), hv)], None).await?;
        if raw_sample.is_none() {
            raw_sample = Some(v.clone());
        }
        if let Some(items) = v.get("data").and_then(|d| d.as_array()) {
            for item in items {
                if let Some(results) = item.get("results").and_then(|r| r.as_array()) {
                    for r in results {
                        let name = r.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        if name == "total" || name.is_empty() {
                            if let Some(value) = lookup_number(r, "amount.value") {
                                total += value;
                            }
                            if let Some(c) = lookup_string(r, "amount.currency") {
                                currency = c;
                            }
                        }
                    }
                }
            }
        }
        let has_more = v.get("has_more").and_then(|h| h.as_bool()).unwrap_or(false);
        if !has_more {
            break;
        }
        page = v
            .get("next_page")
            .and_then(|p| p.as_str())
            .map(|s| s.to_string());
        if page.is_none() {
            break;
        }
    }

    Ok(AccountInfo {
        balance: None,
        used: Some(Money {
            amount: total,
            currency: currency.to_uppercase(),
        }),
        total: None,
        requests: None,
        note: Some(
            "OpenAI 本月用量（需 Admin key；官方无余额查询接口，剩余额度请在平台后台查看）".into(),
        ),
        extras: Vec::new(),
        raw: raw_sample,
        fetched_at: crate::types::now_iso(),
        new_token: None,
        new_refresh_token: None,
    })
}

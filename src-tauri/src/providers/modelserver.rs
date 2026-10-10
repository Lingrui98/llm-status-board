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

pub async fn fetch(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let base = acc.base();
    let mut access = acc.token.clone();
    let mut new_access: Option<String> = None;
    let mut new_refresh: Option<String> = None;

    if access.is_empty() && acc.refresh_token.is_empty() {
        return Err("需要填写 refresh_token（或 access_token）".into());
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

    // 汇总所有项目
    let mut total_balance_cny = 0.0;
    let mut has_wallet = false;
    let mut project_names: Vec<String> = Vec::new();
    let mut raws: Vec<Value> = Vec::new();

    for p in list.iter().take(10) {
        let pid = match p.get("id").and_then(|i| i.as_i64()) {
            Some(id) => id,
            None => continue,
        };
        if let Some(name) = p.get("name").and_then(|n| n.as_str()) {
            project_names.push(name.to_string());
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
                let enabled = d.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false);
                let credits = lookup_number(&d, "balance_credits");
                let price = lookup_number(&d, "credit_unit_prices.cny_fen_per_million");
                if enabled || credits.is_some() {
                    has_wallet = true;
                    if let (Some(c), Some(p)) = (credits, price) {
                        // credits × 元/百万credits：fen_per_million / 1e6 = 元/credit
                        total_balance_cny += c * p / 1_000_000.0;
                    }
                }
                // 本月消费
                if let Some(spent) = lookup_number(&d, "monthly_spent_credits") {
                    if let Some(p) = price {
                        info.extras.push(KeyValue {
                            key: "本月钱包消费".into(),
                            value: format!("{:.2} CNY", spent * p / 1_000_000.0),
                        });
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

        // 订阅窗口（5h / 7d）
        if let Ok(usage) = http::send_json(
            client,
            "GET",
            &format!("{base}/api/v1/projects/{pid}/subscription/usage"),
            &[("Authorization", auth_value.clone())],
            None,
        )
        .await
        {
            if let Some(windows) = usage.get("windows").and_then(|w| w.as_array()) {
                for w in windows {
                    let window = w.get("window").and_then(|x| x.as_str()).unwrap_or("?");
                    let label = match window {
                        "five_hour" => "5h 窗口",
                        "seven_day" => "7d 窗口",
                        other => other,
                    };
                    if let Some(pct) = w.get("used_percent").and_then(|x| x.as_f64()) {
                        info.extras.push(KeyValue {
                            key: label.to_string(),
                            value: format!("{pct:.0}%"),
                        });
                    }
                }
            }
        }
    }

    if has_wallet {
        info.balance = Some(Money {
            amount: total_balance_cny,
            currency: "CNY".into(),
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

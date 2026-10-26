//! Codex subscription usage, matching the official Codex client's read-only wham/usage request.
use crate::types::{AccountConfig, AccountInfo, KeyValue, QuotaWindow};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::{DateTime, Utc};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::Read;

struct Credentials {
    token: String,
    account_id: Option<String>,
}

fn validate_credentials(token: &str, account_id: Option<&str>) -> Result<Credentials, String> {
    let token = token.trim();
    if token.is_empty() {
        return Err("请点击「使用 ChatGPT 登录」，或选择 Codex 登录文件/填写 Access Token".into());
    }
    if token.starts_with("sk-") {
        return Err("Codex 订阅需要 ChatGPT 登录凭据，不能使用 OpenAI API Key".into());
    }
    let account_id = account_id.map(str::trim).filter(|s| !s.is_empty());
    if token.chars().any(char::is_whitespace)
        || token.chars().any(char::is_control)
        || account_id.is_some_and(|id| id.chars().any(char::is_control))
    {
        return Err("登录凭据格式无效，请重新选择文件或复制令牌".into());
    }
    Ok(Credentials {
        token: token.into(),
        account_id: account_id.map(str::to_string),
    })
}

fn credentials(acc: &AccountConfig) -> Result<Credentials, String> {
    if let Some(path) = acc
        .codex_auth_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        // Read only the explicitly selected file, on every refresh; never scan local credentials.
        let file = std::fs::File::open(path)
            .map_err(|_| "无法读取 Codex 登录文件，请重新选择 auth.json".to_string())?;
        let mut data = Vec::new();
        file.take(1_048_577)
            .read_to_end(&mut data)
            .map_err(|_| "读取 Codex 登录文件失败".to_string())?;
        if data.len() > 1_048_576 {
            return Err("Codex 登录文件过大，请选择正确的 auth.json".into());
        }
        let value: Value =
            serde_json::from_slice(&data).map_err(|_| "Codex 登录文件不是有效 JSON".to_string())?;
        if matches!(
            value.get("auth_mode").and_then(Value::as_str),
            Some("apikey" | "api_key")
        ) {
            return Err("此文件使用 API Key 登录，请改用 ChatGPT 登录 Codex".into());
        }
        let tokens = value.get("tokens").ok_or("文件中没有 ChatGPT 登录凭据；请使用 ChatGPT 登录 Codex，系统钥匙串模式可改用手动 Access Token")?;
        let token = tokens
            .get("access_token")
            .and_then(Value::as_str)
            .unwrap_or("");
        let account = tokens.get("account_id").and_then(Value::as_str);
        return validate_credentials(token, account);
    }
    if acc.token.trim().is_empty() && !acc.api_key.trim().is_empty() {
        return Err("Codex 订阅需要 ChatGPT 登录凭据，不能使用 OpenAI API Key".into());
    }
    validate_credentials(&acc.token, acc.chatgpt_account_id.as_deref())
}

fn usage_url(base: &str) -> Result<reqwest::Url, String> {
    let base = if base.trim().is_empty() {
        "https://chatgpt.com"
    } else {
        base.trim()
    };
    let mut url = reqwest::Url::parse(base)
        .map_err(|_| "订阅用量地址应为 https://chatgpt.com".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("chatgpt.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(
            url.path().trim_end_matches('/'),
            "" | "/backend-api" | "/backend-api/wham/usage"
        )
    {
        return Err("订阅用量地址应为 https://chatgpt.com；网络代理请在通用设置中配置".into());
    }
    url.set_path("/backend-api/wham/usage");
    Ok(url)
}

pub async fn fetch(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let url = usage_url(&acc.base_url)?;
    if let Some(id) = acc.chatgpt_auth_id.as_deref().filter(|id| !id.is_empty()) {
        let auth = crate::chatgpt_auth::credentials(id, None).await?;
        let auth = validate_credentials(&auth.token, auth.account_id.as_deref())?;
        return match request_usage(client, url.as_str(), &auth).await {
            Ok(info) => Ok(info),
            Err(FetchError::Unauthorized) => {
                let updated = crate::chatgpt_auth::credentials(id, Some(&auth.token)).await?;
                let updated = validate_credentials(&updated.token, updated.account_id.as_deref())?;
                request_usage(client, url.as_str(), &updated)
                    .await
                    .map_err(FetchError::message)
            }
            Err(error) => Err(error.message()),
        };
    }
    fetch_usage(client, url.as_str(), &credentials(acc)?).await
}

enum FetchError {
    Unauthorized,
    Message(String),
}
impl FetchError {
    fn message(self) -> String {
        match self {
            Self::Unauthorized => {
                "ChatGPT 登录已过期，请重新登录；使用外部 Codex 登录文件时请在 Codex 更新会话"
                    .into()
            }
            Self::Message(message) => message,
        }
    }
}

async fn fetch_usage(
    client: &reqwest::Client,
    url: &str,
    auth: &Credentials,
) -> Result<AccountInfo, String> {
    request_usage(client, url, auth)
        .await
        .map_err(FetchError::message)
}

async fn request_usage(
    client: &reqwest::Client,
    url: &str,
    auth: &Credentials,
) -> Result<AccountInfo, FetchError> {
    let mut request = client
        .get(url)
        .bearer_auth(&auth.token)
        .header("Accept", "application/json");
    if let Some(account) = &auth.account_id {
        request = request.header("ChatGPT-Account-Id", account);
    }
    let response = request.send().await.map_err(|e| {
        FetchError::Message(format!(
            "Codex 订阅查询失败：{}",
            crate::http::describe_request_error(e)
        ))
    })?;
    match response.status().as_u16() {
        401 => return Err(FetchError::Unauthorized),
        403 => {
            return Err(FetchError::Message(
                "ChatGPT 登录无权访问该订阅或请求被网络验证拦截，请检查账号、工作区及网络代理，必要时重新登录"
                    .into(),
            ))
        }
        429 => {
            return Err(FetchError::Message(
                "Codex 用量查询过于频繁，请稍后重试或延长自动刷新间隔".into(),
            ))
        }
        code if !(200..300).contains(&code) => {
            return Err(FetchError::Message(format!(
                "Codex 订阅查询失败：HTTP {code}"
            )))
        }
        _ => {}
    }
    let value = response.json::<Value>().await.map_err(|_| {
        FetchError::Message("Codex 用量响应不是有效 JSON，请检查登录状态及网络验证".into())
    })?;
    let mut info = parse_usage(value, Utc::now()).map_err(FetchError::Message)?;
    info.quota_scope = subscription_scope(auth);
    Ok(info)
}

fn subscription_scope(auth: &Credentials) -> Option<String> {
    let claims = auth
        .token
        .split('.')
        .nth(1)
        .and_then(|part| URL_SAFE_NO_PAD.decode(part).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    let workspace = auth.account_id.as_deref().or_else(|| {
        claims
            .as_ref()
            .and_then(|v| v.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id"))
            .and_then(Value::as_str)
    });
    workspace
        .filter(|id| !id.trim().is_empty())
        .map(|id| format!("{:x}", Sha256::digest(format!("chatgpt-workspace:{id}"))))
}

fn window_label(seconds: Option<i64>, fallback: &str) -> String {
    match seconds {
        Some(18_000) => "5小时".into(),
        Some(604_800) => "每周".into(),
        Some(s) if s > 0 && s % 86_400 == 0 => format!("{}天", s / 86_400),
        Some(s) if s > 0 && s % 3600 == 0 => format!("{}小时", s / 3600),
        Some(s) if s > 0 && s % 60 == 0 => format!("{}分钟", s / 60),
        _ => fallback.into(),
    }
}

fn append_windows(
    info: &mut AccountInfo,
    value: Option<&Value>,
    prefix: &str,
    history_prefix: &str,
    now: DateTime<Utc>,
) -> Result<(), String> {
    let Some(value) = value.filter(|v| !v.is_null()) else {
        return Ok(());
    };
    if !value.is_object() {
        return Err("Codex 配额窗口格式无效".into());
    }
    for (field, fallback) in [("primary_window", "主窗口"), ("secondary_window", "次窗口")] {
        let Some(window) = value.get(field).filter(|v| !v.is_null()) else {
            continue;
        };
        let percent = window
            .get("used_percent")
            .and_then(Value::as_f64)
            .filter(|p| p.is_finite() && *p >= 0.0)
            .ok_or("Codex 配额缺少有效的已用百分比")?;
        let resets_at = if let Some(ts) = window.get("reset_at").filter(|v| !v.is_null()) {
            Some(
                DateTime::from_timestamp(ts.as_i64().ok_or("Codex 重置时间无效")?, 0)
                    .ok_or("Codex 重置时间超出范围")?
                    .to_rfc3339(),
            )
        } else if let Some(seconds) = window.get("reset_after_seconds").filter(|v| !v.is_null()) {
            let seconds = seconds
                .as_i64()
                .filter(|s| *s >= 0)
                .ok_or("Codex 重置倒计时无效")?;
            Some(
                now.checked_add_signed(
                    chrono::Duration::try_seconds(seconds).ok_or("Codex 重置倒计时超出范围")?,
                )
                .ok_or("Codex 重置时间超出范围")?
                .to_rfc3339(),
            )
        } else {
            None
        };
        let seconds = window
            .get("limit_window_seconds")
            .and_then(Value::as_i64)
            .filter(|s| *s > 0);
        let label = window_label(seconds, fallback);
        info.quota_windows.push(QuotaWindow {
            window: Some(format!("{prefix} · {label}")),
            used_percent: Some(percent),
            resets_at,
            history_key: Some(format!(
                "{history_prefix}:{}",
                seconds
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| field.into())
            )),
            window_seconds: seconds,
            ..Default::default()
        });
    }
    Ok(())
}

fn parse_usage(value: Value, now: DateTime<Utc>) -> Result<AccountInfo, String> {
    let plan = value
        .get("plan_type")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .ok_or("响应中没有 Codex 订阅信息，请确认使用 ChatGPT 登录凭据")?;
    let mut info = AccountInfo {
        fetched_at: now.to_rfc3339(),
        ..Default::default()
    };
    info.extras.push(KeyValue {
        key: "订阅套餐".into(),
        value: plan.into(),
    });
    append_windows(&mut info, value.get("rate_limit"), "Codex", "codex", now)?;
    append_windows(
        &mut info,
        value.get("code_review_rate_limit"),
        "代码审查",
        "review",
        now,
    )?;
    if let Some(additional) = value
        .get("additional_rate_limits")
        .and_then(Value::as_array)
    {
        for item in additional {
            let label = item
                .get("limit_name")
                .and_then(Value::as_str)
                .or_else(|| item.get("metered_feature").and_then(Value::as_str))
                .unwrap_or("附加额度");
            let feature = item
                .get("metered_feature")
                .and_then(Value::as_str)
                .unwrap_or(label);
            let key = format!("extra:{:x}", Sha256::digest(feature));
            append_windows(&mut info, item.get("rate_limit"), label, &key, now)?;
        }
    }
    if let Some(allowed) = value
        .pointer("/rate_limit/allowed")
        .and_then(Value::as_bool)
    {
        info.extras.push(KeyValue {
            key: "订阅内用量状态".into(),
            value: if allowed { "可用" } else { "当前受限" }.into(),
        });
    }
    if let Some(credits) = value.get("credits") {
        if credits.get("unlimited").and_then(Value::as_bool) == Some(true) {
            info.extras.push(KeyValue {
                key: "额外 Credits".into(),
                value: "不限额".into(),
            });
        } else if let Some(balance) = credits
            .get("balance")
            .filter(|v| v.is_number() || v.is_string())
        {
            info.extras.push(KeyValue {
                key: "额外 Credits".into(),
                value: balance
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| balance.to_string()),
            });
        }
    }
    info.note = Some(if info.quota_windows.is_empty() {
        "Codex 订阅已连接，但服务端未返回可显示的配额窗口；未推算剩余消息数或美元余额".into()
    } else {
        "Codex 订阅额度；窗口百分比与重置时间由服务端返回，不代表消息数或美元费用".into()
    });
    info.raw = Some(value);
    Ok(info)
}

#[cfg(test)]
#[path = "openai_subscription_tests.rs"]
mod tests;

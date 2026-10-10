use reqwest::{Client, Method, Response};
use std::time::Duration;

pub fn make_client() -> Client {
    Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(15))
        .user_agent("llm-status-board/0.1")
        .build()
        .expect("failed to build http client")
}

pub async fn send_json(
    client: &Client,
    method: &str,
    url: &str,
    headers: &[(&str, String)],
    body: Option<&str>,
) -> Result<serde_json::Value, String> {
    let method = Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| format!("非法 HTTP 方法: {method}"))?;
    let mut req = client.request(method, url);
    for (k, v) in headers {
        req = req.header(*k, v);
    }
    if let Some(b) = body {
        if !b.trim().is_empty() {
            req = req
                .header("Content-Type", "application/json")
                .body(b.to_string());
        }
    }
    let resp: Response = req.send().await.map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    let trimmed = text.trim();
    let value: serde_json::Value = if trimmed.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(trimmed).map_err(|_| {
            format!(
                "HTTP {status}: 响应不是 JSON: {}",
                &trimmed[..trimmed.len().min(300)]
            )
        })?
    };
    if !status.is_success() {
        let msg = extract_error_message(&value).unwrap_or_else(|| format!("HTTP {status}"));
        return Err(msg);
    }
    Ok(value)
}

/// 从常见错误结构里提取可读信息
fn extract_error_message(v: &serde_json::Value) -> Option<String> {
    // {message: "..."} / {error: "..."} / {error:{message}} / {"error":{"message":...}} (Anthropic)
    if let Some(m) = v.get("message").and_then(|m| m.as_str()) {
        return Some(m.to_string());
    }
    if let Some(e) = v.get("error") {
        if let Some(m) = e.as_str() {
            return Some(m.to_string());
        }
        if let Some(m) = e.get("message").and_then(|m| m.as_str()) {
            return Some(m.to_string());
        }
    }
    if let Some(m) = v.get("msg").and_then(|m| m.as_str()) {
        return Some(m.to_string());
    }
    None
}

pub fn bearer(token: &str) -> (String, String) {
    ("Authorization".to_string(), format!("Bearer {token}"))
}

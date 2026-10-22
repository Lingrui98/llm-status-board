use reqwest::{Client, Method, Proxy, Response};
use std::error::Error;
use std::time::Duration;

/// 构建 HTTP 客户端。
/// - proxy: 形如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080；None 时回退到环境变量（http_proxy 等）
pub fn make_client(proxy: Option<&str>) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(30))
        .connect_timeout(Duration::from_secs(15))
        .user_agent("llm-status-board/0.1");
    if let Some(p) = proxy.map(str::trim).filter(|p| !p.is_empty()) {
        let proxy = Proxy::all(p).map_err(|e| format!("代理地址无效（{p}）: {e}"))?;
        builder = builder.proxy(proxy);
    }
    builder
        .build()
        .map_err(|e| format!("构建 HTTP 客户端失败: {e}"))
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
    let resp: Response = req
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", describe_request_error(e)))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", describe_request_error(e)))?;
    let trimmed = text.trim();

    // Cloudflare 人机验证页识别（中转站常见）：返回 HTML 而非 JSON，状态码可能是 200/403/503
    if looks_like_cf_challenge(trimmed) {
        return Err(format!(
            "HTTP {status}: 站点可能开启了 Cloudflare 人机验证，桌面客户端无法通过；请稍后重试或联系站点管理员"
        ));
    }

    let value: serde_json::Value = if trimmed.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_str(trimmed).map_err(|_| {
            // 拿到 HTML 网页通常意味着填的是「前端面板网址」而不是 API 后端地址
            let is_html =
                trimmed.starts_with("<!doctype html") || trimmed.starts_with("<html");
            let hint = if is_html {
                "——响应是 HTML 网页而非 JSON，通常是把网页面板地址填进了站点地址，需要改成 API 后端地址"
            } else {
                ""
            };
            format!(
                "HTTP {status}: 响应不是 JSON{hint}: {}",
                &trimmed[..trimmed.len().min(200)]
            )
        })?
    };
    if !status.is_success() {
        let msg = extract_error_message(&value).unwrap_or_else(|| format!("HTTP {status}"));
        return Err(msg);
    }
    Ok(value)
}

/// reqwest 的 Display 只显示请求摘要，DNS / TLS / 代理等实际原因在 source 链中。
/// URL 可能带有凭证或查询参数，展示原因时不包含 URL。
fn describe_request_error(error: reqwest::Error) -> String {
    let timed_out = error.is_timeout();
    let connect = error.is_connect();
    let error = error.without_url();
    let mut details = vec![error.to_string()];
    let mut cause = error.source();
    while let Some(source) = cause {
        let message = source.to_string();
        if !message.is_empty() && !details.contains(&message) {
            details.push(message);
        }
        cause = source.source();
    }
    let mut message = details.join(": ");
    let lower = message.to_lowercase();
    if lower.contains("certificate") || lower.contains("证书") {
        message.push_str("。TLS 证书校验失败；请检查系统时间与证书信任设置");
    } else if timed_out {
        message.push_str("。请求超时；请检查网络连接或「设置 → 通用设置」中的网络代理");
    } else if connect {
        message.push_str("。连接未建立；请检查网络连接或「设置 → 通用设置」中的网络代理");
    }
    message
}

/// 识别 Cloudflare 挑战页特征（"Just a moment..." / challenge-platform 脚本 / cf-mitigated 头）
fn looks_like_cf_challenge(body: &str) -> bool {
    body.contains("Just a moment")
        || body.contains("challenge-platform")
        || body.contains("cf-chl")
        || body.contains("Attention Required! | Cloudflare")
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

#[cfg(test)]
mod tests {
    use super::{looks_like_cf_challenge, make_client, send_json};
    use std::error::Error;
    use std::net::TcpListener;
    use std::time::Duration;

    #[tokio::test]
    async fn connection_failure_preserves_cause_without_url_credentials() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url =
            format!("http://test-user:private-password@{address}/billing?key=private-query-key");
        let error = client.get(&url).send().await.unwrap_err();
        let mut root: &(dyn Error + 'static) = &error;
        while let Some(source) = root.source() {
            root = source;
        }
        let expected_cause = root.to_string();
        assert!(!expected_cause.is_empty());

        let message = send_json(&client, "GET", &url, &[], None)
            .await
            .unwrap_err();
        assert!(message.contains(&expected_cause), "{message}");
        assert!(message.contains("连接未建立"), "{message}");
        for secret in ["test-user", "private-password", "private-query-key"] {
            assert!(
                !message.contains(secret),
                "URL credentials leaked into error"
            );
        }
    }

    #[tokio::test]
    async fn request_timeout_includes_cause_and_actionable_hint() {
        // Keep a socket listening without sending a response; no public network needed.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/billing", listener.local_addr().unwrap());
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_millis(100))
            .build()
            .unwrap();
        let message = send_json(&client, "GET", &url, &[], None)
            .await
            .unwrap_err();
        assert!(message.contains("operation timed out"), "{message}");
        assert!(message.contains("请求超时"), "{message}");
    }

    #[test]
    fn test_make_client_with_proxies() {
        // 无代理
        assert!(make_client(None).is_ok());
        // 合法 http / socks5 代理
        assert!(make_client(Some("http://127.0.0.1:7890")).is_ok());
        assert!(make_client(Some("socks5://127.0.0.1:1080")).is_ok());
        // 空串/空白 = 未配置，不报错
        assert!(make_client(Some("")).is_ok());
        assert!(make_client(Some("   ")).is_ok());
        // 非法地址：应返回可读错误而不是 panic
        let err = make_client(Some("not a url")).expect_err("非法代理应报错");
        assert!(err.contains("代理地址无效"), "错误应可读: {err}");
    }

    #[test]
    fn test_cf_challenge_detection() {
        // CF 挑战页特征
        assert!(looks_like_cf_challenge(
            "<html><head><title>Just a moment...</title></head></html>"
        ));
        assert!(looks_like_cf_challenge(
            "<script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script>"
        ));
        assert!(looks_like_cf_challenge(
            "<html><body>Attention Required! | Cloudflare</body></html>"
        ));
        // 正常 JSON 与普通页面不误报
        assert!(!looks_like_cf_challenge("{\"code\":0,\"data\":{}}"));
        assert!(!looks_like_cf_challenge(
            "<html><body>正常站点页面</body></html>"
        ));
        assert!(!looks_like_cf_challenge(""));
    }
}

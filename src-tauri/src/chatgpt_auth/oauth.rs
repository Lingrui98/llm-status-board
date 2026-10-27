//! Protocol parameters follow openai/codex's public native-client OAuth flow.
//! This is an independent desktop client; no Codex binary or shared auth.json is used.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::TryRngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

pub(super) const CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub(super) const TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub(super) const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub account_id: Option<String>,
    pub expires_at: i64,
}

pub(super) fn random_id() -> Result<String, String> {
    Ok(random_bytes()?.iter().map(|b| format!("{b:02x}")).collect())
}

fn random_bytes() -> Result<[u8; 32], String> {
    let mut bytes = [0; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "系统随机数不可用，无法安全发起登录".to_string())?;
    Ok(bytes)
}

pub(super) struct Flow {
    pub state: String,
    pub verifier: String,
    pub redirect_uri: String,
    pub auth_url: String,
}

impl Flow {
    pub fn new(port: u16) -> Result<Self, String> {
        let verifier = URL_SAFE_NO_PAD.encode(random_bytes()?);
        let state = URL_SAFE_NO_PAD.encode(random_bytes()?);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let redirect_uri = format!("http://127.0.0.1:{port}/auth/callback");
        let mut url = reqwest::Url::parse("https://auth.openai.com/oauth/authorize").unwrap();
        url.query_pairs_mut().extend_pairs([
            ("response_type", "code"),
            ("client_id", CLIENT_ID),
            ("redirect_uri", &redirect_uri),
            ("scope", "openid profile email offline_access"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
            ("state", &state),
            ("id_token_add_organizations", "true"),
            ("codex_cli_simplified_flow", "true"),
            ("originator", "llm-status-board"),
        ]);
        Ok(Self {
            state,
            verifier,
            redirect_uri,
            auth_url: url.into(),
        })
    }
}

/// Only ports registered for the official public native client; never evict another process.
pub(super) async fn bind_callback() -> Result<TcpListener, String> {
    bind_ports(&[1455, 1457]).await
}

async fn bind_ports(ports: &[u16]) -> Result<TcpListener, String> {
    for port in ports {
        if let Ok(listener) = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, *port)).await {
            return Ok(listener);
        }
    }
    Err("登录回调端口 1455 和 1457 均不可用，请关闭占用端口的程序后重试".into())
}

enum Callback {
    Ignore,
    Code(String),
    Denied,
}

fn callback(request: &str, flow: &Flow) -> Callback {
    let Some((headers, _)) = request.split_once("\r\n\r\n") else {
        return Callback::Ignore;
    };
    let mut lines = headers.split("\r\n");
    let parts: Vec<_> = lines.next().unwrap_or("").split_whitespace().collect();
    if parts.len() != 3
        || parts[0] != "GET"
        || !["HTTP/1.1", "HTTP/1.0"].contains(&parts[2])
        || !parts[1].starts_with("/auth/callback?")
    {
        return Callback::Ignore;
    }
    let hosts: Vec<_> = lines
        .filter_map(|line| line.split_once(':'))
        .filter(|(key, _)| key.eq_ignore_ascii_case("host"))
        .collect();
    let expected = flow
        .redirect_uri
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap();
    if hosts.len() != 1 || hosts[0].1.trim() != expected {
        return Callback::Ignore;
    }
    let Ok(url) = reqwest::Url::parse(&format!("http://{expected}{}", parts[1])) else {
        return Callback::Ignore;
    };
    let pairs: Vec<_> = url.query_pairs().collect();
    let one = |name: &str| {
        let values: Vec<_> = pairs
            .iter()
            .filter(|(k, _)| k == name)
            .map(|(_, v)| v.as_ref())
            .collect();
        (values.len() == 1).then(|| values[0])
    };
    if one("state") != Some(flow.state.as_str()) {
        return Callback::Ignore;
    }
    if let Some(code) =
        one("code").filter(|c| !c.is_empty() && c.len() <= 4096 && !c.chars().any(char::is_control))
    {
        if pairs.iter().any(|(k, _)| k == "error") {
            return Callback::Ignore;
        }
        return Callback::Code(code.to_string());
    }
    if one("error").is_some() && !pairs.iter().any(|(k, _)| k == "code") {
        Callback::Denied
    } else {
        Callback::Ignore
    }
}

async fn read_request(stream: &mut TcpStream) -> Result<String, ()> {
    let mut data = Vec::new();
    loop {
        let mut chunk = [0; 1024];
        let n = stream.read(&mut chunk).await.map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        data.extend_from_slice(&chunk[..n]);
        if data.len() > 8192 {
            return Err(());
        }
        if data.windows(4).any(|s| s == b"\r\n\r\n") {
            return String::from_utf8(data).map_err(|_| ());
        }
    }
}

async fn reply(stream: &mut TcpStream, ok: bool) {
    // Static page only: never reflect the callback, tokens, provider error descriptions, or claims.
    let body = if ok {
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>LLM Status Board</title><h2>登录成功</h2><p>请返回 LLM Status Board 完成保存，可以关闭此页面。</p></html>"
    } else {
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>LLM Status Board</title><h2>未完成登录</h2><p>请返回 LLM Status Board 查看状态或重新发起登录。</p></html>"
    };
    let status = if ok { "200 OK" } else { "400 Bad Request" };
    let response = format!("HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = tokio::time::timeout(
        Duration::from_secs(2),
        stream.write_all(response.as_bytes()),
    )
    .await;
}

pub(super) async fn login(
    listener: TcpListener,
    flow: Flow,
    client: &reqwest::Client,
    endpoint: &str,
) -> Result<Session, String> {
    loop {
        let (mut stream, peer) = listener
            .accept()
            .await
            .map_err(|_| "登录回调连接失败".to_string())?;
        if !peer.ip().is_loopback() {
            continue;
        }
        let request = tokio::time::timeout(Duration::from_secs(3), read_request(&mut stream)).await;
        let action = match request {
            Ok(Ok(request)) => callback(&request, &flow),
            _ => Callback::Ignore,
        };
        match action {
            Callback::Ignore => reply(&mut stream, false).await,
            Callback::Denied => {
                reply(&mut stream, false).await;
                return Err("登录授权未完成，请重试".into());
            }
            Callback::Code(code) => {
                let result = exchange(
                    client,
                    endpoint,
                    &[
                        ("grant_type", "authorization_code"),
                        ("client_id", CLIENT_ID),
                        ("code", &code),
                        ("redirect_uri", &flow.redirect_uri),
                        ("code_verifier", &flow.verifier),
                    ],
                    None,
                )
                .await;
                reply(&mut stream, result.is_ok()).await;
                return result;
            }
        }
    }
}

pub(super) async fn refresh(
    client: &reqwest::Client,
    endpoint: &str,
    previous: &Session,
) -> Result<Session, String> {
    exchange(
        client,
        endpoint,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", CLIENT_ID),
            ("refresh_token", &previous.refresh_token),
        ],
        Some(previous),
    )
    .await
}

async fn exchange(
    client: &reqwest::Client,
    endpoint: &str,
    params: &[(&str, &str)],
    previous: Option<&Session>,
) -> Result<Session, String> {
    let mut response = client
        .post(endpoint)
        .form(params)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            format!(
                "ChatGPT 授权连接失败：{}",
                crate::http::describe_request_error(e)
            )
        })?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            400 | 401 | 403 => "ChatGPT 授权已失效或被拒绝，请重新点击「使用 ChatGPT 登录」".into(),
            429 => "ChatGPT 登录请求过于频繁，请稍后重试".into(),
            code => format!("ChatGPT 授权服务返回 HTTP {code}，请稍后重试"),
        });
    }
    let mut data = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取 ChatGPT 授权响应失败".to_string())?
    {
        if data.len() + chunk.len() > 1_048_576 {
            return Err("ChatGPT 授权响应过大".into());
        }
        data.extend_from_slice(&chunk);
    }
    let value: Value =
        serde_json::from_slice(&data).map_err(|_| "ChatGPT 授权响应格式无效".to_string())?;
    parse_session(&value, previous, chrono::Utc::now().timestamp())
}

fn claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()
}

fn parse_session(value: &Value, previous: Option<&Session>, now: i64) -> Result<Session, String> {
    let valid = |s: &str| {
        !s.is_empty() && s.len() <= 65536 && !s.chars().any(|c| c.is_whitespace() || c.is_control())
    };
    let access = value["access_token"]
        .as_str()
        .filter(|s| valid(s) && !s.starts_with("sk-"))
        .ok_or("ChatGPT 授权响应缺少有效的访问令牌")?;
    let refresh = match value.get("refresh_token") {
        Some(value) => value.as_str().filter(|s| valid(s)),
        None => previous.map(|s| s.refresh_token.as_str()),
    }
    .ok_or("ChatGPT 授权响应缺少有效的刷新令牌")?;
    let access_claims = claims(access);
    let id_claims = value["id_token"].as_str().and_then(claims);
    // Claims are routing/expiry hints from a TLS token response, never local authorization proof.
    let account = id_claims
        .as_ref()
        .and_then(|v| v["https://api.openai.com/auth"]["chatgpt_account_id"].as_str())
        .or_else(|| {
            access_claims
                .as_ref()
                .and_then(|v| v["https://api.openai.com/auth"]["chatgpt_account_id"].as_str())
        })
        .filter(|s| valid(s));
    if previous.is_some_and(|p| {
        p.account_id
            .as_deref()
            .zip(account)
            .is_some_and(|(old, new)| old != new)
    }) {
        return Err("刷新返回了不同的 ChatGPT 工作区，请重新登录".into());
    }
    let expires_at = access_claims
        .as_ref()
        .and_then(|v| v["exp"].as_i64())
        .or_else(|| {
            value["expires_in"]
                .as_i64()
                .filter(|n| *n > 0)
                .and_then(|n| now.checked_add(n))
        })
        .unwrap_or(now + 300);
    if expires_at <= now {
        return Err("ChatGPT 返回的访问令牌已过期，请重新登录".into());
    }
    Ok(Session {
        access_token: access.into(),
        refresh_token: refresh.into(),
        account_id: account
            .map(str::to_string)
            .or_else(|| previous.and_then(|p| p.account_id.clone())),
        expires_at,
    })
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;

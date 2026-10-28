//! ModelServer 面板网页登录。
//!
//! 面板自己的 OIDC 流程只在网页端完成，并在面板 origin 的 localStorage 写入
//! refresh_token。这里使用独立 WebView 等待用户返回面板 origin，再只读取该字段。
//! 不开放远程页面的 Tauri IPC，不把令牌放入 URL，也不在后台提前兑换令牌。

use serde::{Deserialize, Serialize};
use std::{sync::LazyLock, time::Duration};
use tauri::Manager;
use tokio::sync::Mutex;
use url::Url;

pub(crate) const WINDOW_LABEL: &str = "modelserver-login";
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
const POLL_INTERVAL: Duration = Duration::from_millis(800);
const EVAL_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_REFRESH_TOKEN_BYTES: usize = 16 * 1024;

static LOGIN: LazyLock<Mutex<Option<Attempt>>> = LazyLock::new(|| Mutex::new(None));

struct Attempt {
    id: String,
    window_label: String,
    task: Option<tokio::task::JoinHandle<()>>,
    result: Option<Result<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginStart {
    attempt_id: String,
    auth_url: String,
}

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum LoginStatus {
    Pending,
    Complete {
        #[serde(rename = "refreshToken")]
        refresh_token: String,
    },
    Failed {
        message: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCredential {
    origin: String,
    #[serde(default)]
    refresh_token: String,
}

fn random_id() -> Result<String, String> {
    use rand::TryRngCore;
    let mut bytes = [0; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .map_err(|_| "系统随机数不可用，无法安全发起登录".to_string())?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

/// 把 API 或面板地址归一为面板根 URL。codeapi. 只映射回对应的 code. 前端域。
fn panel_url(raw: &str) -> Result<(Url, String), String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("请先填写 ModelServer 站点地址".into());
    }
    let with_scheme = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let mut url = Url::parse(&with_scheme).map_err(|_| "ModelServer 站点地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("ModelServer 登录只支持 HTTP 或 HTTPS 站点".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("ModelServer 站点地址不能包含用户名或密码".into());
    }
    let host = url
        .host_str()
        .ok_or("ModelServer 站点地址缺少主机名")?
        .to_string();
    let panel_host = host
        .strip_prefix("codeapi.")
        .map(|suffix| format!("code.{suffix}"))
        .unwrap_or(host);
    url.set_host(Some(&panel_host))
        .map_err(|_| "ModelServer 面板主机名无效".to_string())?;
    url.set_path("/");
    url.set_query(None);
    url.set_fragment(None);
    let origin = url.origin().ascii_serialization();
    Ok((url, origin))
}

fn allow_navigation(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
}

fn credential_script(origin: &str) -> Result<String, String> {
    let origin = serde_json::to_string(origin)
        .map_err(|_| "无法生成 ModelServer 登录读取脚本".to_string())?;
    Ok(format!(
        r#"(() => {{
  const expectedOrigin = {origin};
  if (window.location.origin !== expectedOrigin) {{
    return {{ origin: window.location.origin, refreshToken: "" }};
  }}
  try {{
    return {{
      origin: window.location.origin,
      refreshToken: window.localStorage.getItem("refresh_token") || ""
    }};
  }} catch (_) {{
    return {{ origin: window.location.origin, refreshToken: "" }};
  }}
}})()"#
    ))
}

fn validate_refresh_token(token: &str) -> Result<(), String> {
    if token.trim() != token
        || token.len() > MAX_REFRESH_TOKEN_BYTES
        || token.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err("面板中的 refresh_token 格式无效，请重新登录".into());
    }
    Ok(())
}

fn parse_browser_credential(raw: &str, expected_origin: &str) -> Result<Option<String>, String> {
    if matches!(raw.trim(), "null" | "{}") {
        return Ok(None);
    }
    let credential: BrowserCredential = serde_json::from_str(raw)
        .map_err(|_| "无法读取 ModelServer 登录页面状态，请重试".to_string())?;
    if credential.origin != expected_origin {
        return Ok(None);
    }
    if credential.refresh_token.is_empty() {
        return Ok(None);
    }
    validate_refresh_token(&credential.refresh_token)?;
    Ok(Some(credential.refresh_token))
}

fn close_window(app: &tauri::AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.close();
    }
}

async fn close_window_and_wait(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    close_window(app, label);
    tokio::time::timeout(Duration::from_secs(2), async {
        while app.get_webview_window(label).is_some() {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| "无法关闭上一次 ModelServer 登录窗口，请手动关闭后重试".to_string())
}

fn focus_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

async fn attempt_finished(id: &str) -> bool {
    let active = LOGIN.lock().await;
    active
        .as_ref()
        .is_none_or(|a| a.id != id || a.result.is_some())
}

async fn finish_attempt(id: &str, result: Result<String, String>) -> bool {
    let mut active = LOGIN.lock().await;
    if let Some(attempt) = active.as_mut().filter(|a| a.id == id && a.result.is_none()) {
        attempt.result = Some(result);
        return true;
    }
    false
}

async fn read_browser_credential(
    app: &tauri::AppHandle,
    window_label: &str,
    webview: &tauri::WebviewWindow,
    expected_origin: &str,
    script: &str,
) -> Result<Option<String>, String> {
    if app.get_webview_window(window_label).is_none() {
        return Err("ModelServer 登录窗口已关闭，请重新发起登录".into());
    }
    let current = webview
        .url()
        .map_err(|_| "ModelServer 登录窗口已关闭，请重新发起登录".to_string())?;
    if current.origin().ascii_serialization() != expected_origin {
        return Ok(None);
    }
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
    if webview
        .eval_with_callback(script, move |raw| {
            let _ = sender.send(raw);
        })
        .is_err()
    {
        // 导航期间的短暂执行失败留给下一次轮询；窗口关闭会由 url() 报错。
        return Ok(None);
    }
    let Ok(Some(raw)) = tokio::time::timeout(EVAL_TIMEOUT, receiver.recv()).await else {
        return Ok(None);
    };
    parse_browser_credential(&raw, expected_origin)
}

async fn run_login(
    app: tauri::AppHandle,
    id: String,
    window_label: String,
    webview: tauri::WebviewWindow,
    expected_origin: String,
    script: String,
) {
    let outcome = tokio::time::timeout(LOGIN_TIMEOUT, async {
        let mut interval = tokio::time::interval(POLL_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if attempt_finished(&id).await {
                return None;
            }
            match read_browser_credential(&app, &window_label, &webview, &expected_origin, &script)
                .await
            {
                Ok(Some(token)) => return Some(Ok(token)),
                Ok(None) => {}
                Err(message) => return Some(Err(message)),
            }
        }
    })
    .await;
    let result = match outcome {
        Ok(Some(result)) => result,
        Ok(None) => return,
        Err(_) => Err("ModelServer 登录等待已超时，请重新发起登录".into()),
    };
    let succeeded = result.is_ok();
    if finish_attempt(&id, result).await {
        close_window(&app, &window_label);
        if succeeded {
            focus_main(&app);
        }
    }
}

#[tauri::command]
pub(crate) async fn start_modelserver_login(
    app: tauri::AppHandle,
    base_url: String,
) -> Result<LoginStart, String> {
    let (auth_url, origin) = panel_url(&base_url)?;
    let script = credential_script(&origin)?;
    let id = random_id()?;
    let window_label = WINDOW_LABEL.to_string();
    let mut active = LOGIN.lock().await;
    if active.as_ref().is_some_and(|a| a.result.is_none()) {
        return Err("已有 ModelServer 登录正在进行，请先完成或取消".into());
    }
    if let Some(old) = active.take() {
        if let Some(task) = old.task {
            task.abort();
        }
    }
    // close() 只发起关闭；等待旧标签真正注销后再创建同标签窗口。
    close_window_and_wait(&app, &window_label).await?;
    let webview = tauri::WebviewWindowBuilder::new(
        &app,
        &window_label,
        tauri::WebviewUrl::External(auth_url.clone()),
    )
    .title("ModelServer 网页登录")
    .inner_size(520.0, 760.0)
    .center()
    .resizable(true)
    .visible(true)
    .focused(true)
    .incognito(true)
    .on_navigation(allow_navigation)
    .build()
    .map_err(|_| "无法创建 ModelServer 登录窗口，请重试".to_string())?;
    *active = Some(Attempt {
        id: id.clone(),
        window_label: window_label.clone(),
        task: None,
        result: None,
    });
    let task = tokio::spawn(run_login(
        app.clone(),
        id.clone(),
        window_label,
        webview,
        origin,
        script,
    ));
    if let Some(attempt) = active.as_mut().filter(|a| a.id == id) {
        attempt.task = Some(task);
    } else {
        task.abort();
    }
    Ok(LoginStart {
        attempt_id: id,
        auth_url: auth_url.to_string(),
    })
}

#[tauri::command]
pub(crate) async fn open_modelserver_login(
    app: tauri::AppHandle,
    attempt_id: String,
) -> Result<(), String> {
    let active = LOGIN.lock().await;
    let attempt = active
        .as_ref()
        .filter(|a| a.id == attempt_id && a.result.is_none())
        .ok_or("ModelServer 登录已结束，请重新发起")?;
    let window = app
        .get_webview_window(&attempt.window_label)
        .ok_or("ModelServer 登录窗口已关闭，请取消后重新发起")?;
    window.show().map_err(|_| "无法显示登录窗口".to_string())?;
    window
        .unminimize()
        .map_err(|_| "无法还原登录窗口".to_string())?;
    window
        .set_focus()
        .map_err(|_| "无法聚焦登录窗口".to_string())
}

#[tauri::command]
pub(crate) async fn modelserver_login_status(attempt_id: String) -> Result<LoginStatus, String> {
    let mut active = LOGIN.lock().await;
    let attempt = active
        .as_mut()
        .filter(|a| a.id == attempt_id)
        .ok_or("ModelServer 登录已取消或不存在")?;
    let Some(result) = attempt.result.take() else {
        return Ok(LoginStatus::Pending);
    };
    let status = match result {
        Ok(refresh_token) => LoginStatus::Complete { refresh_token },
        Err(message) => LoginStatus::Failed { message },
    };
    if let Some(finished) = active.take() {
        if let Some(task) = finished.task {
            task.abort();
        }
    }
    Ok(status)
}

#[tauri::command]
pub(crate) async fn cancel_modelserver_login(
    app: tauri::AppHandle,
    attempt_id: String,
) -> Result<(), String> {
    let attempt = {
        let mut active = LOGIN.lock().await;
        if active.as_ref().is_some_and(|a| a.id == attempt_id) {
            active.take()
        } else {
            None
        }
    };
    if let Some(attempt) = attempt {
        if let Some(task) = attempt.task {
            task.abort();
            let _ = task.await;
        }
        close_window(&app, &attempt.window_label);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn panel_url_maps_api_host_and_discards_path() {
        let (url, origin) = panel_url("https://codeapi.cs.ac.cn/projects/demo?tab=usage").unwrap();
        assert_eq!(url.as_str(), "https://code.cs.ac.cn/");
        assert_eq!(origin, "https://code.cs.ac.cn");
        let (url, _) = panel_url("code.cs.ac.cn/login").unwrap();
        assert_eq!(url.as_str(), "https://code.cs.ac.cn/");
    }

    #[test]
    fn panel_url_preserves_self_hosted_origin() {
        let (url, origin) = panel_url("http://localhost:8080/panel").unwrap();
        assert_eq!(url.as_str(), "http://localhost:8080/");
        assert_eq!(origin, "http://localhost:8080");
    }

    #[test]
    fn panel_url_rejects_invalid_or_credentialed_urls() {
        for raw in ["", "file:///tmp/panel", "https://user:pass@example.com"] {
            assert!(panel_url(raw).is_err(), "应拒绝地址：{raw}");
        }
    }

    #[test]
    fn navigation_is_limited_to_http_urls() {
        assert!(allow_navigation(
            &Url::parse("https://code.cs.ac.cn").unwrap()
        ));
        assert!(allow_navigation(
            &Url::parse("http://localhost:8080").unwrap()
        ));
        assert!(!allow_navigation(
            &Url::parse("file:///etc/passwd").unwrap()
        ));
        assert!(!allow_navigation(&Url::parse("tauri://localhost").unwrap()));
    }

    #[test]
    fn credential_parser_reads_only_expected_panel_origin() {
        let raw = r#"{"origin":"https://code.cs.ac.cn","refreshToken":"fixture-refresh"}"#;
        assert_eq!(
            parse_browser_credential(raw, "https://code.cs.ac.cn").unwrap(),
            Some("fixture-refresh".into())
        );
        assert_eq!(
            parse_browser_credential(raw, "https://id.example.com").unwrap(),
            None
        );
        let other_origin = raw.replace("code.cs.ac.cn", "id.example.com");
        assert_eq!(
            parse_browser_credential(&other_origin, "https://code.cs.ac.cn").unwrap(),
            None
        );
    }

    #[test]
    fn credential_parser_handles_pending_and_invalid_values() {
        for raw in [
            "null",
            "{}",
            r#"{"origin":"https://code.cs.ac.cn","refreshToken":""}"#,
        ] {
            assert_eq!(
                parse_browser_credential(raw, "https://code.cs.ac.cn").unwrap(),
                None
            );
        }
        for token in [" leading", "trailing ", "line\nbreak"] {
            let raw = serde_json::json!({
                "origin": "https://code.cs.ac.cn",
                "refreshToken": token,
            })
            .to_string();
            assert!(parse_browser_credential(&raw, "https://code.cs.ac.cn").is_err());
        }
        assert!(parse_browser_credential("not-json", "https://code.cs.ac.cn").is_err());
    }

    #[test]
    fn login_status_matches_frontend_contract() {
        let value = serde_json::to_value(LoginStatus::Complete {
            refresh_token: "fixture-refresh".into(),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"status":"complete", "refreshToken":"fixture-refresh"})
        );
    }

    #[test]
    fn credential_script_checks_origin_before_reading_storage() {
        let script = credential_script("https://code.cs.ac.cn").unwrap();
        let origin_check = script
            .find("window.location.origin !== expectedOrigin")
            .unwrap();
        let storage_read = script.find("window.localStorage.getItem").unwrap();
        assert!(origin_check < storage_read);
        assert!(!script.contains("access_token"));
    }
}

mod oauth;
mod store;
#[cfg(test)]
mod test_support;

use serde::Serialize;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{LazyLock, OnceLock},
};
use store::{SessionRef, Store};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::Mutex;

static STORE: OnceLock<Store> = OnceLock::new();
static LOGIN: LazyLock<Mutex<Option<Attempt>>> = LazyLock::new(|| Mutex::new(None));

pub(crate) fn init(root: PathBuf) {
    let _ = STORE.set(Store::new(root));
}
fn store() -> Result<&'static Store, String> {
    STORE
        .get()
        .ok_or_else(|| "ChatGPT 登录存储尚未初始化".into())
}

fn oauth_client() -> Result<reqwest::Client, String> {
    let config_path = store()?
        .root
        .parent()
        .ok_or("ChatGPT 配置目录无效")?
        .join("config.json");
    let cfg = crate::config::load_from_path(&config_path)?;
    crate::http::make_oauth_client(cfg.settings.proxy.as_deref())
}

pub(crate) async fn credentials(
    id: &str,
    rejected: Option<&str>,
) -> Result<store::Credentials, String> {
    store()?
        .credentials(&oauth_client()?, oauth::TOKEN_URL, id, rejected)
        .await
}

struct Attempt {
    id: String,
    auth_url: String,
    task: tokio::task::JoinHandle<()>,
    result: Option<Result<SessionRef, String>>,
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
        #[serde(flatten)]
        reference: SessionRef,
    },
    Failed {
        message: String,
    },
}

#[tauri::command]
pub(crate) async fn start_chatgpt_login(app: tauri::AppHandle) -> Result<LoginStart, String> {
    let mut active = LOGIN.lock().await;
    if active.as_ref().is_some_and(|a| a.result.is_none()) {
        return Err("已有 ChatGPT 登录正在进行，请先完成或取消".into());
    }
    if let Some(old) = active.take() {
        old.task.abort();
        if let Some(Ok(reference)) = old.result {
            let _ = store()?.forget(&reference.auth_id).await;
        }
    }
    let client = oauth_client()?;
    let listener = oauth::bind_callback().await?;
    let flow = oauth::Flow::new(
        listener
            .local_addr()
            .map_err(|_| "读取登录回调端口失败")?
            .port(),
    )?;
    let id = oauth::random_id()?;
    let task_id = id.clone();
    let auth_url = flow.auth_url.clone();
    let task = tokio::spawn(async move {
        let result = tokio::time::timeout(
            oauth::LOGIN_TIMEOUT,
            oauth::login(listener, flow, &client, oauth::TOKEN_URL),
        )
        .await
        .unwrap_or_else(|_| Err("登录等待已超时，请重新点击「使用 ChatGPT 登录」".into()));
        let mut active = LOGIN.lock().await;
        if let Some(attempt) = active.as_mut().filter(|a| a.id == task_id) {
            attempt.result = Some(match result {
                Ok(session) => match store() {
                    Ok(store) => store.save_new(session).await,
                    Err(e) => Err(e),
                },
                Err(e) => Err(e),
            });
            if attempt.result.as_ref().is_some_and(Result::is_ok) {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        }
    });
    *active = Some(Attempt {
        id: id.clone(),
        auth_url: auth_url.clone(),
        task,
        result: None,
    });
    Ok(LoginStart {
        attempt_id: id,
        auth_url,
    })
}

#[tauri::command]
pub(crate) async fn open_chatgpt_login(
    app: tauri::AppHandle,
    attempt_id: String,
) -> Result<(), String> {
    let active = LOGIN.lock().await;
    let attempt = active
        .as_ref()
        .filter(|a| a.id == attempt_id && a.result.is_none())
        .ok_or("登录已结束，请重新发起")?;
    // Open only a URL generated in Rust for this pending flow; no arbitrary frontend URL input.
    app.opener()
        .open_url(&attempt.auth_url, None::<&str>)
        .map_err(|_| "无法自动打开浏览器，请复制登录链接到此电脑的浏览器".into())
}

#[tauri::command]
pub(crate) async fn chatgpt_login_status(attempt_id: String) -> Result<LoginStatus, String> {
    let mut active = LOGIN.lock().await;
    let attempt = active
        .as_mut()
        .filter(|a| a.id == attempt_id)
        .ok_or("登录已取消或不存在")?;
    let Some(result) = attempt.result.take() else {
        return Ok(LoginStatus::Pending);
    };
    let status = match result {
        Ok(reference) => LoginStatus::Complete { reference },
        Err(message) => LoginStatus::Failed { message },
    };
    active.take();
    Ok(status)
}

#[tauri::command]
pub(crate) async fn cancel_chatgpt_login(attempt_id: String) -> Result<(), String> {
    let mut active = LOGIN.lock().await;
    if active.as_ref().is_some_and(|a| a.id == attempt_id) {
        let attempt = active.take().unwrap();
        attempt.task.abort();
        // Join to release the loopback listener before an immediate retry.
        let _ = attempt.task.await;
        if let Some(Ok(reference)) = attempt.result {
            store()?.forget(&reference.auth_id).await?;
        }
    }
    Ok(())
}

/// Clean up an abandoned form's credentials, but never a login referenced by a saved account.
#[tauri::command]
pub(crate) async fn discard_chatgpt_auth(
    app: tauri::AppHandle,
    auth_id: String,
) -> Result<(), String> {
    let cfg = crate::config::load(&app)?;
    if cfg
        .accounts
        .iter()
        .any(|a| a.chatgpt_auth_id.as_deref() == Some(auth_id.as_str()))
    {
        return Ok(());
    }
    store()?.forget(&auth_id).await
}

pub(crate) async fn remove_detached(
    previous: &crate::types::AppConfig,
    current: &crate::types::AppConfig,
) {
    if let Ok(store) = store() {
        remove_detached_from(store, previous, current).await;
    }
}

async fn remove_detached_from(
    store: &Store,
    previous: &crate::types::AppConfig,
    current: &crate::types::AppConfig,
) {
    let referenced: HashSet<_> = current
        .accounts
        .iter()
        .filter_map(|a| a.chatgpt_auth_id.as_deref())
        .collect();
    let detached: HashSet<_> = previous
        .accounts
        .iter()
        .filter_map(|a| a.chatgpt_auth_id.as_deref())
        .filter(|id| !referenced.contains(id))
        .collect();
    for id in detached {
        let _ = store.forget(id).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AccountConfig, AppConfig};

    #[test]
    fn login_status_matches_frontend_contract_without_tokens() {
        let value = serde_json::to_value(LoginStatus::Complete {
            reference: SessionRef {
                auth_id: "opaque-reference".into(),
                account_id: Some("workspace".into()),
            },
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"status":"complete", "authId":"opaque-reference", "accountId":"workspace"})
        );
    }

    #[tokio::test]
    async fn disconnect_deletes_only_after_last_saved_reference_is_removed() {
        let root = std::env::temp_dir().join(format!(
            "llm-board-auth-detach-{}",
            oauth::random_id().unwrap()
        ));
        let store = Store::new(root.clone());
        let reference = store
            .save_new(oauth::Session {
                access_token: "fixture-access".into(),
                refresh_token: "fixture-refresh".into(),
                account_id: None,
                expires_at: i64::MAX,
            })
            .await
            .unwrap();
        let account = AccountConfig {
            chatgpt_auth_id: Some(reference.auth_id.clone()),
            ..Default::default()
        };
        let previous = AppConfig {
            accounts: vec![account.clone(), account.clone()],
            ..Default::default()
        };
        let still_used = AppConfig {
            accounts: vec![account],
            ..Default::default()
        };
        remove_detached_from(&store, &previous, &still_used).await;
        assert!(root.join(format!("{}.json", reference.auth_id)).exists());
        remove_detached_from(&store, &still_used, &AppConfig::default()).await;
        assert!(!root.join(format!("{}.json", reference.auth_id)).exists());
        std::fs::remove_dir(root).unwrap();
    }
}

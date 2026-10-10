use crate::config;
use crate::http;
use crate::providers;
use crate::types::{AccountConfig, AccountInfo, AppConfig, RefreshOutcome};
use futures::future::join_all;
use tauri::AppHandle;

#[tauri::command]
pub async fn get_config(app: AppHandle) -> Result<AppConfig, String> {
    config::load(&app)
}

#[tauri::command]
pub async fn save_config(app: AppHandle, config: AppConfig) -> Result<(), String> {
    config::save(&app, &config)
}

#[tauri::command]
pub async fn config_path(app: AppHandle) -> Result<String, String> {
    Ok(config::config_file_path(&app)?
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
pub async fn test_account(app: AppHandle, account: AccountConfig) -> Result<AccountInfo, String> {
    let client = http::make_client();
    let info = providers::fetch_account(&client, &account).await?;

    // 一次性 refresh token 轮换回写：如果测试的是已保存在配置里的账号，
    // 把轮换出的新 token 持久化，避免配置里留下已失效的旧 token
    if info.new_token.is_some() || info.new_refresh_token.is_some() {
        if let Ok(mut cfg) = config::load(&app) {
            if let Some(a) = cfg.accounts.iter_mut().find(|a| a.id == account.id) {
                let mut dirty = false;
                if let Some(t) = &info.new_token {
                    if a.token != *t {
                        a.token = t.clone();
                        dirty = true;
                    }
                }
                if let Some(r) = &info.new_refresh_token {
                    if a.refresh_token != *r {
                        a.refresh_token = r.clone();
                        dirty = true;
                    }
                }
                if dirty {
                    let _ = config::save(&app, &cfg);
                }
            }
        }
    }
    Ok(info)
}

#[tauri::command]
pub async fn refresh_all(app: AppHandle) -> Result<Vec<RefreshOutcome>, String> {
    let cfg = config::load(&app)?;
    let client = http::make_client();

    let enabled: Vec<AccountConfig> = cfg.accounts.iter().filter(|a| a.enabled).cloned().collect();

    let tasks = enabled.into_iter().map(|acc| {
        let client = client.clone();
        async move {
            let id = acc.id.clone();
            match providers::fetch_account(&client, &acc).await {
                Ok(info) => (
                    acc,
                    RefreshOutcome {
                        account_id: id,
                        ok: true,
                        info: Some(info),
                        error: None,
                    },
                ),
                Err(e) => (
                    acc,
                    RefreshOutcome {
                        account_id: id,
                        ok: false,
                        info: None,
                        error: Some(e),
                    },
                ),
            }
        }
    });
    let results = join_all(tasks).await;

    // token 轮转回写
    let mut cfg = cfg;
    let mut dirty = false;
    for (acc, outcome) in &results {
        if let Some(info) = &outcome.info {
            if let Some(t) = &info.new_token {
                if let Some(a) = cfg.accounts.iter_mut().find(|a| a.id == acc.id) {
                    if a.token != *t {
                        a.token = t.clone();
                        dirty = true;
                    }
                }
            }
            if let Some(r) = &info.new_refresh_token {
                if let Some(a) = cfg.accounts.iter_mut().find(|a| a.id == acc.id) {
                    if a.refresh_token != *r {
                        a.refresh_token = r.clone();
                        dirty = true;
                    }
                }
            }
        }
    }
    if dirty {
        let _ = config::save(&app, &cfg);
    }

    Ok(results.into_iter().map(|(_, o)| o).collect())
}

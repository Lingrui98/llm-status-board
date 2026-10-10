use crate::config;
use crate::http;
use crate::providers;
use crate::types::{AccountConfig, AccountInfo, AppConfig, RefreshOutcome};
use futures::future::join_all;
use tauri::{AppHandle, Manager};

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

/// 导出当前配置到指定路径（含 API Key，前端已提示用户注意文件安全）
#[tauri::command]
pub async fn export_config(app: AppHandle, path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("导出路径为空".into());
    }
    let cfg = config::load(&app)?;
    config::save_to_path(std::path::Path::new(&path), &cfg)
}

/// 从指定路径导入配置：返回导入后的完整配置（设置替换、账号按 id 合并去重）
#[tauri::command]
pub async fn import_config(app: AppHandle, path: String) -> Result<AppConfig, String> {
    if path.trim().is_empty() {
        return Err("导入路径为空".into());
    }
    let imported: AppConfig = config::load_from_path(std::path::Path::new(&path))
        .map_err(|e| format!("导入失败: {e}"))?;
    if imported.version != 1 {
        return Err(format!(
            "不支持的配置版本: {}（本应用为 v1）",
            imported.version
        ));
    }

    let mut current = config::load(&app)?;
    // 设置整体替换
    current.settings = imported.settings;
    // 账号按 id 合并：导入的覆盖同 id 的旧账号，其余追加
    for acc in imported.accounts {
        match current.accounts.iter_mut().find(|a| a.id == acc.id) {
            Some(old) => *old = acc,
            None => current.accounts.push(acc),
        }
    }
    current.version = 1;
    config::save(&app, &current)?;
    Ok(current)
}

#[tauri::command]
pub async fn test_account(app: AppHandle, account: AccountConfig) -> Result<AccountInfo, String> {
    let cfg = config::load(&app)?;
    let client = http::make_client(cfg.settings.proxy.as_deref())?;
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
    let client = http::make_client(cfg.settings.proxy.as_deref())?;

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

    // 结果持久化：下次启动时直接展示上次数据（时间戳保持为旧值）
    let outcomes: Vec<RefreshOutcome> = results.into_iter().map(|(_, o)| o).collect();
    if let Ok(dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("results.json");
        if let Ok(text) = serde_json::to_string_pretty(&outcomes) {
            let tmp = dir.join("results.json.tmp");
            if std::fs::write(&tmp, &text).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
        }
    }

    Ok(outcomes)
}

/// 上次刷新结果（启动时加载展示；无记录返回空数组）
#[tauri::command]
pub async fn get_last_results(app: AppHandle) -> Result<Vec<RefreshOutcome>, String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("{e}"))?
        .join("results.json");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取结果失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("结果文件格式错误: {e}"))
}

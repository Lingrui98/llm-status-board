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
    // R14 AC-9 的服务端保障：越界阈值拒绝落盘（前端也有同样的即时校验，这里是兜底）
    crate::types::validate_settings(&config.settings)?;
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
    // 导入的 settings 会整体替换本地设置，因此同样要过范围校验
    crate::types::validate_settings(&imported.settings).map_err(|e| format!("导入失败: {e}"))?;

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
    if let Ok(path) = config::results_file_path(&app) {
        // 持久化失败不影响本次刷新结果返回
        let _ = config::save_results(&path, &outcomes);
    }

    // 余额历史追加（趋势图数据源 / R14 洞察指标差分推导的数据基础）；
    // R14 规格 §2：快照结构不动
    let now = crate::types::now_iso();
    let snapshots: Vec<crate::types::BalanceSnapshot> = outcomes
        .iter()
        .filter_map(|o| {
            o.info
                .as_ref()?
                .balance
                .as_ref()
                .map(|b| crate::types::BalanceSnapshot {
                    ts: now.clone(),
                    account_id: o.account_id.clone(),
                    balance: b.amount,
                    currency: b.currency.clone(),
                })
        })
        .collect();
    if !snapshots.is_empty() {
        if let Ok(path) = config::history_file_path(&app) {
            let _ = config::append_history(&path, &snapshots);
        }
    }

    Ok(outcomes)
}

/// 上次刷新结果（启动时加载展示；无记录返回空数组）
#[tauri::command]
pub async fn get_last_results(app: AppHandle) -> Result<Vec<RefreshOutcome>, String> {
    config::load_results(&config::results_file_path(&app)?)
}

/// 余额历史快照（趋势图数据源；无记录返回空数组）
#[tauri::command]
pub async fn get_history(app: AppHandle) -> Result<Vec<crate::types::BalanceSnapshot>, String> {
    config::load_history(&config::history_file_path(&app)?)
}

/// 本地用量历史总账（R15 §2）：文件缺失 → `{version:1, records:[]}`；
/// 解析失败/版本过高 → 可读中文错误（**读路径不改动原文件**）
#[tauri::command]
pub async fn get_usage_history(app: AppHandle) -> Result<crate::types::UsageHistoryFile, String> {
    config::load_usage_history(&config::usage_history_file_path(&app)?)
}

/// 合并写入本地用量历史（R15 §1.3，**Rust 是唯一合并点**），返回合并清理后的总条数。
/// 同批次重复调用内容全等时不写盘；损坏文件先备份再自愈；所有失败路径都返回中文可读错误、不 panic。
#[tauri::command]
pub async fn upsert_usage_history(
    app: AppHandle,
    records: Vec<crate::types::UsageRecord>,
) -> Result<usize, String> {
    config::upsert_usage_history(&config::usage_history_file_path(&app)?, &records)
}

/// R16 §6：前端回报「自动刷新已暂停」状态（前端是唯一真值源，Rust 不自行翻转）。
/// 仅更新托盘菜单文案/tooltip 的运行态，**不持久化**、不返回业务错误之外的信息。
#[tauri::command]
pub async fn set_auto_refresh_paused(app: AppHandle, paused: bool) -> Result<(), String> {
    crate::tray::apply_auto_refresh_paused(&app, paused);
    Ok(())
}

/// R18：立即显示用量总结浮层（兜底入口，不依赖悬停；按最近一次悬停几何定位）
#[tauri::command]
pub async fn show_summary_popup(app: AppHandle) -> Result<(), String> {
    crate::summary::show_now(&app);
    Ok(())
}

/// R18：立即隐藏浮层（Escape / 失焦 / 左键 / 点击账号行都走它）
#[tauri::command]
pub async fn hide_summary_popup(app: AppHandle) -> Result<(), String> {
    crate::summary::hide_now(&app);
    Ok(())
}

/// R18：浮层内指针进入/离开 —— `true` 取消待隐藏，`false` 重新起 250ms 隐藏
#[tauri::command]
pub async fn set_summary_pointer_inside(app: AppHandle, inside: bool) -> Result<(), String> {
    crate::summary::set_pointer_inside(&app, inside);
    Ok(())
}

/// R18：点击浮层里的账号行 → 显示并聚焦主窗口 + 切到该账号详情，随后隐藏浮层。
/// 复用既有 `tray-open-account` 事件（主界面 App.tsx 已在监听，无需改动）。
#[tauri::command]
pub async fn summary_open_account(app: AppHandle, account_id: String) -> Result<(), String> {
    if account_id.trim().is_empty() {
        return Err("账号 id 为空".into());
    }
    crate::tray::open_account_detail(&app, &account_id);
    crate::summary::on_row_click(&app);
    Ok(())
}

/// 报表导出（R14）：CSV 内容由前端纯函数 `buildUsageCsv` 组好（含 UTF-8 BOM、
/// RFC 4180 转义、CRLF），Rust 只做**原子字节写入**，不加工、不裁剪 content。
#[tauri::command]
pub async fn export_csv(_app: AppHandle, path: String, content: String) -> Result<(), String> {
    // 原样字节落盘（BOM/换行/转义都由前端 content 决定），成功时只回 ()
    config::write_bytes_atomic(std::path::Path::new(&path), content.as_bytes()).map(|_| ())
}

use crate::config;
use crate::http;
use crate::providers;
use crate::types::{AccountConfig, AccountInfo, AppConfig, BalanceSnapshot, RefreshOutcome};
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
    let previous = config::load(&app).unwrap_or_default();
    config::save(&app, &config)?;
    crate::chatgpt_auth::remove_detached(&previous, &config).await;
    // R23：配额显示模式等托盘相关设置变更后即时重建菜单（重建失败不阻塞保存结果）
    crate::tray::rebuild_menu_now(&app);
    Ok(())
}

#[tauri::command]
pub async fn config_path(app: AppHandle) -> Result<String, String> {
    Ok(config::config_file_path(&app)?
        .to_string_lossy()
        .into_owned())
}

fn clear_device_login_references(config: &mut AppConfig) {
    for account in &mut config.accounts {
        account.chatgpt_auth_id = None;
        account.codex_auth_path = None;
    }
}

fn config_export_copy(config: &AppConfig) -> AppConfig {
    let mut exported = config.clone();
    clear_device_login_references(&mut exported);
    exported
}

fn merge_imported_config(previous: &AppConfig, mut imported: AppConfig) -> AppConfig {
    // 旧版导出文件也可能含有其他设备的登录引用，合并前必须移除。
    clear_device_login_references(&mut imported);
    let mut current = previous.clone();
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
    current
}

/// 导出当前配置到指定路径（含 API Key，前端已提示用户注意文件安全）
#[tauri::command]
pub async fn export_config(app: AppHandle, path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("导出路径为空".into());
    }
    let cfg = config_export_copy(&config::load(&app)?);
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

    let previous = config::load(&app)?;
    let current = merge_imported_config(&previous, imported);
    config::save(&app, &current)?;
    crate::chatgpt_auth::remove_detached(&previous, &current).await;
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
                        history_error: None,
                    },
                ),
                Err(e) => (
                    acc,
                    RefreshOutcome {
                        account_id: id,
                        ok: false,
                        info: None,
                        error: Some(e),
                        history_error: None,
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

    let mut outcomes = Vec::with_capacity(results.len());
    for (account, mut outcome) in results {
        if account.kind == crate::types::ProviderKind::OpenAiSubscription {
            if let Some(info) = &mut outcome.info {
                if let Err(error) = crate::quota_history::record(&app, &account.id, info).await {
                    info.quota_history_error = Some(error);
                }
            }
        }
        outcomes.push(outcome);
    }
    // 同秒内连续刷新也有独立游标，避免秒级时间戳漏记差分。
    let now = chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Nanos, true);
    let snapshots = balance_snapshots(&outcomes, &now);
    let resets: Vec<String> = outcomes
        .iter()
        .filter(|o| {
            o.ok && o
                .info
                .as_ref()
                .is_some_and(|i| i.balance.as_ref().is_none_or(|b| !b.amount.is_finite()))
        })
        .map(|o| o.account_id.clone())
        .collect();
    if !snapshots.is_empty() || !resets.is_empty() {
        let saved = (|| {
            let history = config::history_file_path(&app)?;
            let usage = config::usage_history_file_path(&app)?;
            let accounts = cfg
                .accounts
                .iter()
                .filter(|a| a.enabled)
                .map(|a| a.id.clone())
                .collect::<Vec<_>>();
            config::record_balance_history(&history, &usage, &snapshots, &accounts, &resets, &now)
        })();
        if let Err(error) = saved {
            for outcome in outcomes.iter_mut().filter(|o| o.ok) {
                outcome.history_error = Some(error.clone());
            }
        }
    }

    // 历史写入失败独立记录，查询结果照常可用。
    if let Ok(path) = config::results_file_path(&app) {
        let _ = config::save_results(&path, &outcomes);
    }

    Ok(outcomes)
}

fn balance_snapshots(outcomes: &[RefreshOutcome], ts: &str) -> Vec<BalanceSnapshot> {
    outcomes
        .iter()
        .filter(|o| o.ok)
        .filter_map(|o| {
            let info = o.info.as_ref()?;
            let balance = info.balance.as_ref().filter(|b| b.amount.is_finite())?;
            let total = info
                .total
                .as_ref()
                .filter(|t| t.currency == balance.currency && t.amount.is_finite())
                .map(|t| t.amount);
            Some(BalanceSnapshot {
                ts: ts.to_owned(),
                account_id: o.account_id.clone(),
                balance: balance.amount,
                currency: balance.currency.clone(),
                total,
            })
        })
        .collect()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Money;

    fn outcome(total: Option<Money>) -> RefreshOutcome {
        RefreshOutcome {
            account_id: "aihubmix".into(),
            ok: true,
            info: Some(AccountInfo {
                balance: Some(Money {
                    amount: 10.0,
                    currency: "USD".into(),
                }),
                total,
                ..Default::default()
            }),
            error: None,
            history_error: None,
        }
    }

    #[test]
    fn snapshots_record_real_totals_including_zero_without_guessing() {
        for (total, currency, expected) in [
            (Some(100.0), "USD", Some(100.0)),
            (Some(0.0), "USD", Some(0.0)),
            (None, "USD", None),
            (Some(100.0), "CNY", None),
            (Some(f64::NAN), "USD", None),
            (Some(f64::INFINITY), "USD", None),
        ] {
            let result = outcome(total.map(|amount| Money {
                amount,
                currency: currency.into(),
            }));
            let snapshots = balance_snapshots(&[result], "2026-10-19T10:00:00Z");
            assert_eq!(snapshots.len(), 1);
            assert_eq!(snapshots[0].total, expected);
            assert_eq!(snapshots[0].balance, 10.0);
            assert_eq!(snapshots[0].currency, "USD");
            assert_eq!(snapshots[0].ts, "2026-10-19T10:00:00Z");
        }
    }

    #[test]
    fn failed_or_missing_balance_results_do_not_add_snapshots() {
        let mut failed = outcome(None);
        failed.ok = false;
        let mut no_balance = outcome(Some(Money {
            amount: 100.0,
            currency: "USD".into(),
        }));
        no_balance.info.as_mut().unwrap().balance = None;
        let mut no_info = outcome(None);
        no_info.info = None;
        let mut invalid_balance = outcome(None);
        invalid_balance
            .info
            .as_mut()
            .unwrap()
            .balance
            .as_mut()
            .unwrap()
            .amount = f64::NAN;
        assert!(
            balance_snapshots(&[failed, no_balance, no_info, invalid_balance], "now").is_empty()
        );
    }

    #[test]
    fn export_copy_clears_only_device_bound_login_references() {
        let source = AppConfig {
            accounts: vec![
                AccountConfig {
                    id: "chatgpt".into(),
                    name: "ChatGPT".into(),
                    token: "manual-token".into(),
                    refresh_token: "manual-refresh".into(),
                    codex_auth_path: Some(r"C:\device\chatgpt-auth.json".into()),
                    chatgpt_account_id: Some("workspace".into()),
                    chatgpt_auth_id: Some("local-chatgpt-auth".into()),
                    ..Default::default()
                },
                AccountConfig {
                    id: "codex".into(),
                    codex_auth_path: Some(r"C:\device\codex-auth.json".into()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let exported = config_export_copy(&source);

        assert!(exported.accounts.iter().all(|account| {
            account.chatgpt_auth_id.is_none() && account.codex_auth_path.is_none()
        }));
        assert_eq!(
            source.accounts[0].chatgpt_auth_id.as_deref(),
            Some("local-chatgpt-auth")
        );
        assert_eq!(
            source.accounts[0].codex_auth_path.as_deref(),
            Some(r"C:\device\chatgpt-auth.json")
        );
        assert_eq!(
            source.accounts[1].codex_auth_path.as_deref(),
            Some(r"C:\device\codex-auth.json")
        );

        let mut expected = source.clone();
        for account in &mut expected.accounts {
            account.chatgpt_auth_id = None;
            account.codex_auth_path = None;
        }
        assert_eq!(
            serde_json::to_value(exported).unwrap(),
            serde_json::to_value(expected).unwrap()
        );
    }

    #[test]
    fn export_copy_preserves_manual_tokens_and_chatgpt_account_id() {
        let source = AppConfig {
            accounts: vec![AccountConfig {
                api_key: "manual-api-key".into(),
                token: "manual-token".into(),
                refresh_token: "manual-refresh-token".into(),
                chatgpt_account_id: Some("manual-workspace".into()),
                chatgpt_auth_id: Some("local-auth".into()),
                codex_auth_path: Some("local-auth.json".into()),
                ..Default::default()
            }],
            ..Default::default()
        };

        let exported = config_export_copy(&source);
        let account = &exported.accounts[0];
        assert_eq!(account.api_key, "manual-api-key");
        assert_eq!(account.token, "manual-token");
        assert_eq!(account.refresh_token, "manual-refresh-token");
        assert_eq!(
            account.chatgpt_account_id.as_deref(),
            Some("manual-workspace")
        );
        assert_eq!(account.chatgpt_auth_id, None);
        assert_eq!(account.codex_auth_path, None);
    }

    #[test]
    fn import_merge_detaches_overwritten_local_auth_and_clears_legacy_references() {
        let previous = AppConfig {
            accounts: vec![
                AccountConfig {
                    id: "replace".into(),
                    token: "old-local-token".into(),
                    chatgpt_auth_id: Some("local-replaced".into()),
                    codex_auth_path: Some("old-local-auth.json".into()),
                    ..Default::default()
                },
                AccountConfig {
                    id: "keep".into(),
                    chatgpt_auth_id: Some("local-kept".into()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        let imported = AppConfig {
            accounts: vec![
                AccountConfig {
                    id: "replace".into(),
                    token: "imported-manual-token".into(),
                    refresh_token: "imported-manual-refresh".into(),
                    chatgpt_account_id: Some("imported-workspace".into()),
                    chatgpt_auth_id: Some("legacy-exported-auth".into()),
                    codex_auth_path: Some("legacy-exported-auth.json".into()),
                    ..Default::default()
                },
                AccountConfig {
                    id: "append".into(),
                    chatgpt_auth_id: Some("other-device-auth".into()),
                    codex_auth_path: Some("other-device-auth.json".into()),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        let current = merge_imported_config(&previous, imported);

        assert_eq!(current.accounts.len(), 3);
        let replaced = &current.accounts[0];
        assert_eq!(replaced.id, "replace");
        assert_eq!(replaced.token, "imported-manual-token");
        assert_eq!(replaced.refresh_token, "imported-manual-refresh");
        assert_eq!(
            replaced.chatgpt_account_id.as_deref(),
            Some("imported-workspace")
        );
        assert_eq!(replaced.chatgpt_auth_id, None);
        assert_eq!(replaced.codex_auth_path, None);
        assert_eq!(
            current.accounts[1].chatgpt_auth_id.as_deref(),
            Some("local-kept")
        );
        assert_eq!(current.accounts[2].chatgpt_auth_id, None);
        assert_eq!(current.accounts[2].codex_auth_path, None);
        assert_eq!(
            previous.accounts[0].chatgpt_auth_id.as_deref(),
            Some("local-replaced")
        );

        // remove_detached 使用这两个纯数据集合确定需要删除的本机凭据。
        let referenced: std::collections::HashSet<_> = current
            .accounts
            .iter()
            .filter_map(|account| account.chatgpt_auth_id.as_deref())
            .collect();
        let detached: std::collections::HashSet<_> = previous
            .accounts
            .iter()
            .filter_map(|account| account.chatgpt_auth_id.as_deref())
            .filter(|id| !referenced.contains(id))
            .collect();
        assert_eq!(
            detached,
            std::collections::HashSet::from(["local-replaced"])
        );
    }
}

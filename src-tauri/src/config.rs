use crate::types::{AppConfig, BalanceSnapshot, RefreshOutcome};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// 历史快照保留上限（超出丢弃最旧）
const MAX_HISTORY: usize = 2000;

pub fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法确定配置目录: {e}"))?;
    Ok(dir.join("config.json"))
}

pub fn results_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法确定配置目录: {e}"))?;
    Ok(dir.join("results.json"))
}

pub fn history_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法确定配置目录: {e}"))?;
    Ok(dir.join("history.json"))
}

/// 原子写入刷新结果（与配置同目录的 results.json）
pub fn save_results(path: &Path, outcomes: &[RefreshOutcome]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建结果目录失败: {e}"))?;
    }
    let text =
        serde_json::to_string_pretty(outcomes).map_err(|e| format!("序列化结果失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &text).map_err(|e| format!("写入结果失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换结果文件失败: {e}"))?;
    Ok(())
}

/// 读取上次刷新结果；文件不存在返回空数组（首次启动）
pub fn load_results(path: &Path) -> Result<Vec<RefreshOutcome>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取结果失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("结果文件格式错误: {e}"))
}

/// 追加余额快照（滚动保留最近 MAX_HISTORY 条；同账号余额与最近一条相同时不追加，避免平线刷屏）
pub fn append_history(path: &Path, snapshots: &[BalanceSnapshot]) -> Result<(), String> {
    let mut all = load_history(path)?;
    for s in snapshots {
        let dup = all
            .last()
            .map(|last| {
                last.account_id == s.account_id && (last.balance - s.balance).abs() < f64::EPSILON
            })
            .unwrap_or(false);
        if !dup {
            all.push(s.clone());
        }
    }
    if all.len() > MAX_HISTORY {
        let drain = all.len() - MAX_HISTORY;
        all.drain(..drain);
    }
    save_history(path, &all)
}

pub fn save_history(path: &Path, snapshots: &[BalanceSnapshot]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建历史目录失败: {e}"))?;
    }
    let text =
        serde_json::to_string_pretty(snapshots).map_err(|e| format!("序列化历史失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &text).map_err(|e| format!("写入历史失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换历史文件失败: {e}"))?;
    Ok(())
}

/// 读取全部余额快照（趋势图数据源）
pub fn load_history(path: &Path) -> Result<Vec<BalanceSnapshot>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取历史失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("历史文件格式错误: {e}"))
}

/// 原子写入「任意字节」（R14 `export_csv` 用）：先写临时文件再 rename，避免写一半损坏文件。
///
/// **原样落盘**：不做编码转换、不裁剪、不去除 BOM（CSV 的 UTF-8 BOM 由前端写进 content）。
/// 返回写入字节数，便于调用方/测试核对。
pub fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> Result<usize, String> {
    if path.as_os_str().to_string_lossy().trim().is_empty() {
        return Err("导出路径为空".into());
    }
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            fs::create_dir_all(dir).map_err(|e| format!("创建导出目录失败: {e}"))?;
        }
    }
    // 临时文件名沿用 save_results 的 `<完整名>.tmp` 约定（不替换扩展名，
    // 避免与用户目录里同名的 xxx.tmp 冲突）
    let mut tmp_os = path.as_os_str().to_os_string();
    tmp_os.push(".tmp");
    let tmp = Path::new(&tmp_os);
    fs::write(tmp, bytes).map_err(|e| format!("写入文件失败: {e}"))?;
    fs::rename(tmp, path).map_err(|e| format!("替换文件失败: {e}"))?;
    Ok(bytes.len())
}

pub fn load(app: &tauri::AppHandle) -> Result<AppConfig, String> {
    load_from_path(&config_file_path(app)?)
}

pub fn save(app: &tauri::AppHandle, config: &AppConfig) -> Result<(), String> {
    save_to_path(&config_file_path(app)?, config)
}

/// 从指定路径读取配置；文件不存在时返回默认配置（首次启动）
pub fn load_from_path(path: &Path) -> Result<AppConfig, String> {
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取配置失败: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("配置文件格式错误: {e}"))
}

/// 原子写入：先写临时文件再 rename，避免写一半损坏配置
pub fn save_to_path(path: &Path, config: &AppConfig) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| format!("序列化配置失败: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &text).map_err(|e| format!("写入配置失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("替换配置文件失败: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{AccountConfig, ProviderKind};

    fn temp_config_path(tag: &str) -> PathBuf {
        // 用项目 target 目录而不是系统 TEMP（部分沙箱环境限制测试进程写 TEMP）
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join(format!("{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir.join("config.json")
    }

    #[test]
    fn test_round_trip_and_missing_default() {
        let path = temp_config_path("roundtrip");
        let _ = fs::remove_file(&path);

        // 不存在 → 默认配置
        let cfg = load_from_path(&path).unwrap();
        assert!(cfg.accounts.is_empty());
        assert!(cfg.settings.refresh_on_start);

        // 写入带账号的配置
        let mut cfg = AppConfig::default();
        cfg.accounts.push(AccountConfig {
            id: "a1".into(),
            name: "测试".into(),
            kind: ProviderKind::Sub2Api,
            base_url: "https://example.com".into(),
            api_key: "sk-x".into(),
            refresh_token: "rt-old".into(),
            ..Default::default()
        });
        save_to_path(&path, &cfg).unwrap();

        // 读回一致
        let back = load_from_path(&path).unwrap();
        assert_eq!(back.accounts.len(), 1);
        assert_eq!(back.accounts[0].id, "a1");
        assert_eq!(back.accounts[0].kind, ProviderKind::Sub2Api);
        assert_eq!(back.accounts[0].refresh_token, "rt-old");

        // 原子写不应残留 .tmp 文件
        assert!(!path.with_extension("json.tmp").exists());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn test_corrupt_file_reports_friendly_error() {
        let path = temp_config_path("corrupt");
        fs::write(&path, "{ not valid json !!").unwrap();
        let err = load_from_path(&path).expect_err("损坏配置应报错");
        assert!(err.contains("配置文件格式错误"), "错误信息应可读: {err}");
        let _ = fs::remove_file(&path);
    }

    /// 导入合并语义验证：设置替换、账号同 id 覆盖 + 新 id 追加
    #[test]
    fn test_import_merge_semantics() {
        let base_path = temp_config_path("import-base");
        let import_path = temp_config_path("import-file");

        // 当前配置：acc1 + acc2
        let mut base = AppConfig::default();
        base.accounts.push(AccountConfig {
            id: "acc1".into(),
            name: "旧名1".into(),
            kind: ProviderKind::DeepSeek,
            base_url: "https://api.deepseek.com".into(),
            api_key: "sk-old".into(),
            ..Default::default()
        });
        base.accounts.push(AccountConfig {
            id: "acc2".into(),
            name: "保留2".into(),
            ..Default::default()
        });
        save_to_path(&base_path, &base).unwrap();

        // 导入文件：acc1（新内容）+ acc3（新账号）
        let mut imported = AppConfig::default();
        imported.settings.auto_refresh_sec = 300;
        imported.accounts.push(AccountConfig {
            id: "acc1".into(),
            name: "新名1".into(),
            kind: ProviderKind::Sub2Api,
            base_url: "https://relay.example.com".into(),
            api_key: "sk-new".into(),
            ..Default::default()
        });
        imported.accounts.push(AccountConfig {
            id: "acc3".into(),
            name: "新增3".into(),
            ..Default::default()
        });
        save_to_path(&import_path, &imported).unwrap();

        // 合并（模拟 import_config 的核心逻辑）
        let mut current = load_from_path(&base_path).unwrap();
        current.settings = imported.settings.clone();
        for acc in imported.accounts {
            match current.accounts.iter_mut().find(|a| a.id == acc.id) {
                Some(old) => *old = acc,
                None => current.accounts.push(acc),
            }
        }

        assert_eq!(current.accounts.len(), 3);
        let acc1 = current.accounts.iter().find(|a| a.id == "acc1").unwrap();
        assert_eq!(acc1.name, "新名1");
        assert_eq!(acc1.kind, ProviderKind::Sub2Api);
        assert_eq!(acc1.api_key, "sk-new");
        assert!(current
            .accounts
            .iter()
            .any(|a| a.id == "acc2" && a.name == "保留2"));
        assert!(current.accounts.iter().any(|a| a.id == "acc3"));
        assert_eq!(current.settings.auto_refresh_sec, 300);

        let _ = fs::remove_file(&base_path);
        let _ = fs::remove_file(&import_path);
    }

    /// 导出文件应与源配置内容一致（可直接再导入）
    #[test]
    fn test_export_round_trip() {
        let src = temp_config_path("export-src");
        let dst = temp_config_path("export-dst");
        let _ = fs::remove_file(&dst);

        let mut cfg = AppConfig::default();
        cfg.accounts.push(AccountConfig {
            id: "a".into(),
            name: "测试".into(),
            kind: ProviderKind::OneApi,
            base_url: "https://x.example.com".into(),
            token: "tok".into(),
            ..Default::default()
        });
        save_to_path(&src, &cfg).unwrap();
        // 导出 = 把同一份配置写到另一路径
        save_to_path(&dst, &cfg).unwrap();

        let back = load_from_path(&dst).unwrap();
        assert_eq!(back.accounts.len(), 1);
        assert_eq!(back.accounts[0].token, "tok");
        let _ = fs::remove_file(&src);
        let _ = fs::remove_file(&dst);
    }

    /// 刷新结果持久化：写读往返、首次启动空数组、损坏文件可读错误
    #[test]
    fn test_results_round_trip() {
        let path = temp_config_path("results").with_file_name("results.json");
        let _ = fs::remove_file(&path);

        // 首次启动：文件不存在 → 空数组
        assert!(load_results(&path).unwrap().is_empty());

        // 写入两条结果（一成功一失败）
        let outcomes = vec![
            crate::types::RefreshOutcome {
                account_id: "a1".into(),
                ok: true,
                info: Some(crate::types::AccountInfo {
                    balance: Some(crate::types::Money {
                        amount: 5.5,
                        currency: "USD".into(),
                    }),
                    fetched_at: "2026-10-10T10:00:00+08:00".into(),
                    ..Default::default()
                }),
                error: None,
            },
            crate::types::RefreshOutcome {
                account_id: "a2".into(),
                ok: false,
                info: None,
                error: Some("HTTP 401".into()),
            },
        ];
        save_results(&path, &outcomes).unwrap();

        let back = load_results(&path).unwrap();
        assert_eq!(back.len(), 2);
        assert!(back[0].ok);
        assert_eq!(
            back[0]
                .info
                .as_ref()
                .unwrap()
                .balance
                .as_ref()
                .unwrap()
                .amount,
            5.5
        );
        assert_eq!(back[1].error.as_deref(), Some("HTTP 401"));
        // 原子写不残留 .tmp
        assert!(!path.with_extension("json.tmp").exists());

        // 损坏文件 → 可读错误
        fs::write(&path, "###").unwrap();
        let err = load_results(&path).expect_err("损坏结果应报错");
        assert!(err.contains("结果文件格式错误"), "错误应可读: {err}");
        let _ = fs::remove_file(&path);
    }

    /// R14 AC-8：旧 config.json（没有 5 个新字段）必须无迁移直接加载；
    /// 保存后新字段落盘，且 load_from_path 往返一致
    #[test]
    fn test_legacy_config_without_r14_fields_loads() {
        let path = temp_config_path("legacy-r14");
        // 第十三轮及更早版本写出的配置：settings 里没有任何 R14 字段
        let legacy = r#"{
            "version": 1,
            "settings": { "autoRefreshSec": 0, "refreshOnStart": true, "proxy": null, "closeToTray": null },
            "accounts": [
                { "id": "old-1", "name": "旧账号", "kind": "sub2Api", "enabled": true,
                  "baseUrl": "https://relay.example.com", "apiKey": "sk-old", "token": "",
                  "refreshToken": "", "userId": null, "username": "", "password": "",
                  "quotaPerUnit": null, "custom": null }
            ]
        }"#;
        fs::write(&path, legacy).unwrap();

        let cfg = load_from_path(&path).expect("旧配置必须可加载");
        assert_eq!(cfg.accounts.len(), 1);
        assert_eq!(cfg.accounts[0].id, "old-1");
        // None = 前端按默认阈值工作（true / 1 / 7 / 85 / 14）
        assert_eq!(cfg.settings.notify_enabled, None);
        assert_eq!(cfg.settings.notify_low_balance_usd, None);
        assert_eq!(cfg.settings.notify_low_balance_cny, None);
        assert_eq!(cfg.settings.notify_quota_percent, None);
        assert_eq!(cfg.settings.insight_window_days, None);
        assert!(crate::types::validate_settings(&cfg.settings).is_ok());

        // 设置页改阈值 → 保存 → 新字段落盘 → 读回一致
        let mut edited = cfg;
        edited.settings.notify_enabled = Some(false);
        edited.settings.notify_low_balance_usd = Some(10.0);
        edited.settings.notify_quota_percent = Some(90.0);
        edited.settings.insight_window_days = Some(30);
        save_to_path(&path, &edited).unwrap();

        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("\"notifyLowBalanceUsd\": 10.0"),
            "实际: {text}"
        );
        assert!(text.contains("\"insightWindowDays\": 30"));
        assert!(
            !text.contains("notify_low_balance_usd"),
            "不得写 snake_case"
        );

        let back = load_from_path(&path).unwrap();
        assert_eq!(back.settings.notify_enabled, Some(false));
        assert_eq!(back.settings.notify_low_balance_usd, Some(10.0));
        assert_eq!(back.settings.notify_quota_percent, Some(90.0));
        assert_eq!(back.settings.insight_window_days, Some(30));
        // 旧账号数据不受影响
        assert_eq!(back.accounts[0].api_key, "sk-old");
        let _ = fs::remove_file(&path);
    }

    /// R14 `export_csv` 的写入路径：原子落盘、BOM 与内容逐字节保留
    #[test]
    fn test_write_bytes_atomic_preserves_bom_byte_for_byte() {
        let path = temp_config_path("export-csv").with_file_name("llm-usage.csv");
        let _ = fs::remove_file(&path);

        // 前端 buildUsageCsv 的产物：BOM + 中文表头 + 含逗号/引号的转义字段 + CRLF
        let content =
            "\u{feff}账号名称,账号类型,币种,日期,当日花费,当日请求数,当日Token,当日余额快照\r\n\
                       \"中转站, 主号\",\"new-api 系中转\",USD,2026-10-15,1.5,7,1234,10.25\r\n";
        let n = write_bytes_atomic(&path, content.as_bytes()).unwrap();
        assert_eq!(n, content.len());

        let raw = fs::read(&path).unwrap();
        assert_eq!(&raw[..3], &[0xEF, 0xBB, 0xBF], "首字节必须是 UTF-8 BOM");
        assert_eq!(
            String::from_utf8(raw).unwrap(),
            content,
            "必须原样落盘，不得加工/裁剪"
        );
        assert!(
            !path.with_file_name("llm-usage.csv.tmp").exists(),
            "不应残留临时文件"
        );

        // 覆写已存在文件也应成功（rename 覆盖）
        let n2 = write_bytes_atomic(&path, b"\xEF\xBB\xBFx").unwrap();
        assert_eq!(n2, 4);
        assert_eq!(fs::read(&path).unwrap(), b"\xEF\xBB\xBFx");

        // 临时文件名是 `<完整名>.tmp`，不会覆盖同目录里扩展名被替换后的同名文件
        let decoy = path.with_extension("tmp");
        fs::write(&decoy, "decoy").unwrap();
        write_bytes_atomic(&path, "\u{feff}second".as_bytes()).unwrap();
        assert_eq!(
            fs::read_to_string(&decoy).unwrap(),
            "decoy",
            "不得覆盖他人文件"
        );
        assert!(!path.with_file_name("llm-usage.csv.tmp").exists());
        let _ = fs::remove_file(&decoy);

        // 空路径：可读错误而不是 panic
        let err = write_bytes_atomic(Path::new(""), b"x").expect_err("空路径应报错");
        assert!(err.contains("导出路径为空"), "错误应可读: {err}");

        // 父目录不存在时自动创建（与 save_results 一致）
        let nested = temp_config_path("export-nested")
            .with_file_name("sub")
            .join("deep")
            .join("out.csv");
        write_bytes_atomic(&nested, "\u{feff}ok".as_bytes()).unwrap();
        assert!(nested.exists(), "应自动创建父目录");
        let _ = fs::remove_file(&nested);
        let _ = fs::remove_file(&path);
    }
}

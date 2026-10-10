use crate::types::AppConfig;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

pub fn config_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法确定配置目录: {e}"))?;
    Ok(dir.join("config.json"))
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
}

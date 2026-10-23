use crate::types::{
    AppConfig, BalanceSnapshot, RefreshOutcome, UsageHistoryFile, UsageRecord,
    USAGE_CURRENCY_UNKNOWN, USAGE_HISTORY_VERSION, USAGE_SOURCE_LOCAL, USAGE_SOURCE_SITE,
};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// 每账号保留最近 90 天，15 万条可覆盖每分钟刷新一次的完整窗口。
const HISTORY_RETENTION_DAYS: i64 = 90;
const MAX_HISTORY_PER_ACCOUNT: usize = 150_000;

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

/// 每次成功查询都记录采样时间，包括余额或总额度不变的情况。
/// 按账号保留最近 90 天、最多 15 万条；旧四字段快照仍可直接读取。
pub fn append_history(path: &Path, snapshots: &[BalanceSnapshot]) -> Result<(), String> {
    let mut all = load_history(path)?;
    all.extend_from_slice(snapshots);
    let retained = retain_history(all, chrono::Utc::now().timestamp_millis());
    save_history(path, &retained)
}

fn retain_history(snapshots: Vec<BalanceSnapshot>, now_ms: i64) -> Vec<BalanceSnapshot> {
    let cutoff = now_ms - chrono::Duration::days(HISTORY_RETENTION_DAYS).num_milliseconds();
    let mut dated: Vec<_> = snapshots
        .into_iter()
        .filter_map(|snapshot| {
            let ts = chrono::DateTime::parse_from_rfc3339(&snapshot.ts)
                .ok()?
                .timestamp_millis();
            (ts >= cutoff).then_some((ts, snapshot))
        })
        .collect();
    dated.sort_by(|(at, a), (bt, b)| {
        at.cmp(bt)
            .then_with(|| a.account_id.cmp(&b.account_id))
            .then_with(|| a.currency.cmp(&b.currency))
    });
    dated.dedup_by(|(at, a), (bt, b)| {
        at == bt
            && a.account_id == b.account_id
            && a.currency == b.currency
            && a.balance == b.balance
            && a.total == b.total
    });
    let mut counts = HashMap::new();
    let mut retained: Vec<_> = dated
        .into_iter()
        .rev()
        .filter_map(|(_, snapshot)| {
            let count = counts.entry(snapshot.account_id.clone()).or_insert(0usize);
            if *count >= MAX_HISTORY_PER_ACCOUNT {
                return None;
            }
            *count += 1;
            Some(snapshot)
        })
        .collect();
    retained.reverse();
    retained
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

// ---------- R15 本地用量历史（usage-history.json）----------

/// R15 §1.4：每账号保留最近多少天
pub const MAX_USAGE_DAYS_PER_ACCOUNT: usize = 400;
/// R15 §1.4：总条数上限
pub const MAX_USAGE_RECORDS: usize = 20_000;

pub fn usage_history_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("无法确定配置目录: {e}"))?;
    Ok(dir.join("usage-history.json"))
}

/// 内部读取错误：对外都是可读中文 Err，但 upsert 需要区分两者——
/// 损坏 → 备份后自愈重建；版本过高 → 拒绝且**绝不**动原文件。
enum UsageHistoryIssue {
    /// 解析失败（JSON 损坏）
    Corrupt(String),
    /// `version > USAGE_HISTORY_VERSION`
    FutureVersion(String),
}

impl UsageHistoryIssue {
    fn message(&self) -> &str {
        match self {
            Self::Corrupt(m) | Self::FutureVersion(m) => m,
        }
    }
}

fn read_usage_history(path: &Path, text: &str) -> Result<UsageHistoryFile, UsageHistoryIssue> {
    let file: UsageHistoryFile = serde_json::from_str(text).map_err(|e| {
        UsageHistoryIssue::Corrupt(format!("用量历史文件格式错误（{}）: {e}", path.display()))
    })?;
    if file.version > USAGE_HISTORY_VERSION {
        return Err(UsageHistoryIssue::FutureVersion(format!(
            "用量历史文件版本 {} 高于本应用支持的 {}，已保留原文件不做修改（{}）",
            file.version,
            USAGE_HISTORY_VERSION,
            path.display()
        )));
    }
    Ok(file)
}

/// 读取用量历史（R15 §1.5 读路径）：
/// - 文件缺失 → `{version:1, records:[]}`（首次启动）
/// - 解析失败 / 版本过高 → 可读中文 Err，**不移动、不改写原文件**（读路径零副作用）
pub fn load_usage_history(path: &Path) -> Result<UsageHistoryFile, String> {
    if !path.exists() {
        return Ok(UsageHistoryFile::default());
    }
    let text = fs::read_to_string(path).map_err(|e| format!("读取用量历史失败: {e}"))?;
    read_usage_history(path, &text).map_err(|issue| issue.message().to_string())
}

/// 把损坏文件重命名为 `usage-history.corrupt-<unix秒>.json`（§1.5 写路径留痕）。
/// 若该名字已被占用则追加 `-1`、`-2`…，**绝不覆盖已有备份**。
fn backup_corrupt_usage_history(path: &Path) -> Result<PathBuf, String> {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut target = path.with_file_name(format!("usage-history.corrupt-{secs}.json"));
    let mut n = 1u32;
    while target.exists() {
        target = path.with_file_name(format!("usage-history.corrupt-{secs}-{n}.json"));
        n += 1;
    }
    fs::rename(path, &target).map_err(|e| format!("重命名损坏文件失败: {e}"))?;
    Ok(target)
}

/// 合并一个批次（R15 §1.3，**Rust 是唯一合并点**）：
/// 键 `(accountId, date)`；`site` 覆盖 `local`，`local` **永不**覆盖 `site`，
/// 同 source 同键 → 新值覆盖旧值（同一天多次刷新只留最新）。
pub fn merge_usage_records(all: &mut Vec<UsageRecord>, batch: &[UsageRecord]) {
    for rec in batch {
        match all
            .iter_mut()
            .find(|r| r.account_id == rec.account_id && r.date == rec.date)
        {
            // 站点批次一律覆盖；本地批次只能覆盖同为 local 的旧值
            Some(slot) if rec.is_site() || !slot.is_site() => *slot = rec.clone(),
            Some(_) => {}
            None => all.push(rec.clone()),
        }
    }
}

/// 清理（R15 §1.4）：①每账号按 `date` 降序保留最近 `MAX_USAGE_DAYS_PER_ACCOUNT` 天；
/// ②总量超 `MAX_USAGE_RECORDS` 时按 `(date, accountId)` 升序丢最旧直到 ≤ 上限。
/// 最后按 `(accountId, date)` 升序排序——落盘顺序稳定，§1.3 的幂等字节比较依赖它。
pub fn trim_usage_records(records: &mut Vec<UsageRecord>) {
    let mut keep: HashSet<(String, String)> = HashSet::new();
    let mut dates_by_account: HashMap<String, Vec<String>> = HashMap::new();
    for r in records.iter() {
        dates_by_account
            .entry(r.account_id.clone())
            .or_default()
            .push(r.date.clone());
    }
    for (account, dates) in dates_by_account.iter_mut() {
        dates.sort();
        dates.dedup();
        for d in dates.iter().rev().take(MAX_USAGE_DAYS_PER_ACCOUNT) {
            keep.insert((account.clone(), d.clone()));
        }
    }
    records.retain(|r| keep.contains(&(r.account_id.clone(), r.date.clone())));

    if records.len() > MAX_USAGE_RECORDS {
        records.sort_by(|a, b| {
            a.date
                .cmp(&b.date)
                .then_with(|| a.account_id.cmp(&b.account_id))
        });
        let drain = records.len() - MAX_USAGE_RECORDS;
        records.drain(..drain);
    }
    records.sort_by(|a, b| {
        a.account_id
            .cmp(&b.account_id)
            .then_with(|| a.date.cmp(&b.date))
    });
}

/// R15 §1.1 防御式兜底：文档对外声明 `currency` **永不空串**，不能只靠调用方自觉。
/// 写入前 `trim()`：空串/纯空白 → `USAGE_CURRENCY_UNKNOWN`。
/// **不做大小写归一**（归一由前端 `src/usageHistory.ts` 负责，Rust 不与其规则打架）。
pub fn normalize_usage_currency(records: &mut [UsageRecord]) {
    for r in records.iter_mut() {
        let trimmed = r.currency.trim();
        r.currency = if trimmed.is_empty() {
            USAGE_CURRENCY_UNKNOWN.to_string()
        } else {
            trimmed.to_string()
        };
    }
}

/// R16 §7 防御式兜底：丢弃「全空行」——六个可空数值字段
/// （`cost`/`requests`/`tokens`/`inputTokens`/`outputTokens`/`usedTotal`）**全为 `null`**
/// 的记录不携带任何信息，写入前剔除（与前端 `usageHistory.ts#isEmptyUsageRow` 同判据）。
///
/// **必须保留 B2 基准行**：只要 `usedTotal` 有值（used 计数器法的增量基准），
/// 删掉它下次就算不出 delta，所以它不算「空行」。
/// 作用范围：入批 + 合并后的整账（整账中的全空行同样无信息损失）。
pub fn drop_empty_usage_records(records: &mut Vec<UsageRecord>) {
    records.retain(|r| {
        r.cost.is_some()
            || r.requests.is_some()
            || r.tokens.is_some()
            || r.input_tokens.is_some()
            || r.output_tokens.is_some()
            || r.used_total.is_some()
    });
}

/// R15 §1.1 防御式兜底：`source` 只允许 `USAGE_SOURCE_SITE` / `USAGE_SOURCE_LOCAL`。
/// 未知/空/大小写不匹配（`"foo"` / `""` / `"SITE"`）一律降级为 `"local"`——
/// **绝不冒充 site**（site 是权威数据，只有前端明确声明才配得上）。
///
/// 安全性：合并判定（`merge_usage_records`）用的是**原始** source，本函数在合并**之后**
/// 才执行，所以任何脏值都不可能覆盖既有 site 行；已存在的脏 source 行也会在写入时被修复。
pub fn normalize_usage_source(records: &mut [UsageRecord]) {
    for r in records.iter_mut() {
        // 严格相等：只有逐字 `"site"` 才保留，其余（含 "SITE"）降级为 local
        if r.source != USAGE_SOURCE_SITE {
            r.source = USAGE_SOURCE_LOCAL.to_string();
        }
    }
}

/// 原子写出（临时文件 + rename，沿用 `save_history` 模式；不残留 `.tmp`）
fn write_usage_history_text(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        if !dir.as_os_str().is_empty() {
            fs::create_dir_all(dir).map_err(|e| format!("创建用量历史目录失败: {e}"))?;
        }
    }
    let mut tmp_os = path.as_os_str().to_os_string();
    tmp_os.push(".tmp");
    let tmp = Path::new(&tmp_os);
    fs::write(tmp, text).map_err(|e| format!("写入用量历史失败: {e}"))?;
    fs::rename(tmp, path).map_err(|e| format!("替换用量历史文件失败: {e}"))?;
    Ok(())
}

/// upsert：把前端批次并入总账，返回合并清理后的**总条数**（R15 §1.3/§1.4/§1.5）。
///
/// - §1.3 强幂等：内容全等 → **完全不写盘**（文件字节与 mtime 不变）
/// - §1.5 写路径自愈：现有文件损坏 → **先备份**为 `usage-history.corrupt-<unix秒>.json`，
///   再用本批记录重建；备份失败则拒绝写入（宁可这次不写，也不覆盖未留痕的旧数据）。
///   备份文件名写入日志（§2 的返回类型 `Result<usize, String>` 在成功路径上没有携带文本的位置）。
/// - §1.5 版本过高 → 返回 Err 且不覆盖原文件
/// - 空批次 **且** 文件不存在 → 直接 `Ok(0)`，不创建无意义的空文件
pub fn upsert_usage_history(path: &Path, batch: &[UsageRecord]) -> Result<usize, String> {
    let existing_text = if path.exists() {
        Some(fs::read_to_string(path).map_err(|e| format!("读取用量历史失败: {e}"))?)
    } else {
        None
    };

    // 空批次 + 文件不存在：不落盘（避免用户配置目录里出现无意义空文件）。
    // 文件已存在时按原逻辑处理，以保持 §1.3 的字节幂等。
    if batch.is_empty() && existing_text.is_none() {
        return Ok(0);
    }

    let mut file = match existing_text.as_deref() {
        None => UsageHistoryFile::default(),
        Some(text) => match read_usage_history(path, text) {
            Ok(f) => f,
            Err(UsageHistoryIssue::FutureVersion(m)) => return Err(m),
            Err(UsageHistoryIssue::Corrupt(m)) => {
                let backup = backup_corrupt_usage_history(path).map_err(|be| {
                    format!(
                        "用量历史文件损坏且备份失败（{be}）：为避免覆盖原文件，本次不写入。原错误: {m}"
                    )
                })?;
                eprintln!(
                    "[usage-history] {m}；原文件已备份为 {}，本次将用新批次重建",
                    backup.display()
                );
                UsageHistoryFile::default()
            }
        },
    };

    let mut records = std::mem::take(&mut file.records);
    merge_usage_records(&mut records, batch);
    trim_usage_records(&mut records);
    // 落盘前兜底：合并后的整份总账（含既有行）都不得出现空币种/非法 source/全空行
    normalize_usage_currency(&mut records);
    normalize_usage_source(&mut records);
    drop_empty_usage_records(&mut records);
    // 入批与既有行都被净化后一条不剩、且原本没有文件 → 别创建无意义的空文件
    if records.is_empty() && existing_text.is_none() {
        return Ok(0);
    }
    file.version = USAGE_HISTORY_VERSION;
    file.records = records;
    let total = file.records.len();

    let text =
        serde_json::to_string_pretty(&file).map_err(|e| format!("序列化用量历史失败: {e}"))?;
    // §1.3 幂等：内容全等 → 不碰文件（字节与 mtime 均不变）
    if existing_text.as_deref() == Some(text.as_str()) {
        return Ok(total);
    }
    write_usage_history_text(path, &text)?;
    Ok(total)
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

    fn history_snapshot(
        account: &str,
        ts: chrono::DateTime<chrono::Utc>,
        balance: f64,
    ) -> BalanceSnapshot {
        BalanceSnapshot {
            ts: ts.to_rfc3339(),
            account_id: account.into(),
            balance,
            currency: "USD".into(),
            total: None,
        }
    }

    #[test]
    fn history_keeps_flat_totals_and_total_only_changes() {
        let path = temp_config_path("total-history").with_file_name("history.json");
        let _ = fs::remove_file(&path);
        let base = chrono::Utc::now() - chrono::Duration::hours(4);
        let legacy = serde_json::json!([{"ts":base.to_rfc3339(),"accountId":"a1","balance":10.0,"currency":"USD"}]);
        fs::write(&path, legacy.to_string()).unwrap();
        for (index, total) in [100.0, 100.0, 150.0].into_iter().enumerate() {
            let mut snapshot =
                history_snapshot("a1", base + chrono::Duration::hours(index as i64 + 1), 10.0);
            snapshot.total = Some(total);
            append_history(&path, std::slice::from_ref(&snapshot)).unwrap();
            append_history(&path, &[snapshot]).unwrap();
        }
        let history = load_history(&path).unwrap();
        assert_eq!(history.len(), 4);
        assert_eq!(
            history.iter().map(|s| s.total).collect::<Vec<_>>(),
            vec![None, Some(100.0), Some(100.0), Some(150.0)]
        );
        assert!(history.iter().all(|s| s.balance == 10.0));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn history_keeps_more_than_2000_readings_and_flat_balances() {
        let path = temp_config_path("larger-history").with_file_name("history.json");
        let _ = fs::remove_file(&path);
        let now = chrono::Utc::now();
        let snapshots: Vec<_> = (0..3000)
            .map(|i| history_snapshot("a1", now - chrono::Duration::minutes(3000 - i), 10.0))
            .collect();
        append_history(&path, &snapshots).unwrap();
        append_history(&path, &snapshots).unwrap();
        let history = load_history(&path).unwrap();
        assert_eq!(
            history.len(),
            3000,
            "相同时间点去重，但不同时间的相同余额仍是有效采样"
        );
        assert!(history.iter().all(|s| s.total.is_none()));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn history_retention_is_per_account_and_keeps_the_newest_readings() {
        let now = chrono::Utc::now();
        let mut snapshots: Vec<_> = (0..MAX_HISTORY_PER_ACCOUNT + 5)
            .map(|i| {
                history_snapshot(
                    "busy",
                    now - chrono::Duration::seconds((MAX_HISTORY_PER_ACCOUNT + 10 - i) as i64),
                    i as f64,
                )
            })
            .collect();
        snapshots.reverse(); // 文件顺序不可靠时仍按真实时间保留最新记录。
        snapshots.push(history_snapshot(
            "quiet",
            now - chrono::Duration::days(3),
            42.0,
        ));
        let retained = retain_history(snapshots, now.timestamp_millis());
        assert_eq!(
            retained.iter().filter(|s| s.account_id == "busy").count(),
            MAX_HISTORY_PER_ACCOUNT
        );
        assert_eq!(
            retained
                .iter()
                .find(|s| s.account_id == "busy")
                .unwrap()
                .balance,
            5.0
        );
        assert_eq!(
            retained.iter().filter(|s| s.account_id == "quiet").count(),
            1,
            "高频账号不能挤掉低频账号的历史"
        );
    }

    #[test]
    fn history_retention_handles_day_boundary_offsets_and_invalid_dates() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-10-22T00:00:00Z")
            .unwrap()
            .to_utc();
        let at_cutoff = history_snapshot("a1", now - chrono::Duration::days(90), 1.0);
        let expired = history_snapshot(
            "a1",
            now - chrono::Duration::days(90) - chrono::Duration::milliseconds(1),
            0.0,
        );
        let current = history_snapshot("a1", now, 2.0);
        let mut same_instant = current.clone();
        same_instant.ts = "2026-10-22T08:00:00+08:00".into();
        let mut invalid = current.clone();
        invalid.ts = "invalid-date".into();
        let retained = retain_history(
            vec![current, expired, invalid, at_cutoff, same_instant],
            now.timestamp_millis(),
        );
        assert_eq!(
            retained.iter().map(|s| s.balance).collect::<Vec<_>>(),
            vec![1.0, 2.0]
        );
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

    // ---------- R15 usage-history.json ----------

    fn usage_temp_path(tag: &str) -> PathBuf {
        temp_config_path(tag).with_file_name("usage-history.json")
    }

    fn day(offset: i64) -> String {
        (chrono::NaiveDate::from_ymd_opt(2025, 1, 1).unwrap() + chrono::Duration::days(offset))
            .format("%Y-%m-%d")
            .to_string()
    }

    fn rec(account: &str, date: &str, cost: Option<f64>, source: &str) -> UsageRecord {
        UsageRecord {
            account_id: account.into(),
            date: date.into(),
            cost,
            currency: "USD".into(),
            requests: Some(3),
            input_tokens: None,
            output_tokens: None,
            tokens: None,
            used_total: None,
            source: source.into(),
            updated_at: "2026-10-15T10:00:00+08:00".into(),
        }
    }

    fn corrupt_backups(path: &Path) -> Vec<PathBuf> {
        let dir = path.parent().unwrap();
        let mut found: Vec<PathBuf> = fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().starts_with("usage-history.corrupt-"))
                    .unwrap_or(false)
            })
            .collect();
        found.sort();
        found
    }

    /// §1.5：文件缺失 → 默认空封套，且读路径不创建任何文件
    #[test]
    fn test_usage_history_missing_file_is_empty_default() {
        let path = usage_temp_path("usage-missing");
        let _ = fs::remove_file(&path);

        let file = load_usage_history(&path).unwrap();
        assert_eq!(file.version, 1);
        assert!(file.records.is_empty());
        assert!(!path.exists(), "读缺失文件不得创建文件");
        assert!(corrupt_backups(&path).is_empty());
    }

    /// §1.3 / AC-3 强幂等：同批次重复 upsert → 文件字节与 mtime 均不变、总条数不变
    #[test]
    fn test_upsert_same_batch_twice_is_byte_identical() {
        let path = usage_temp_path("usage-idempotent");
        let _ = fs::remove_file(&path);
        let batch = vec![
            rec("a1", "2026-10-15", Some(20.0), "local"),
            rec("a2", "2026-10-15", Some(9.0), "site"),
        ];

        let n1 = upsert_usage_history(&path, &batch).unwrap();
        assert_eq!(n1, 2);
        let bytes1 = fs::read(&path).unwrap();
        let mtime1 = fs::metadata(&path).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(25));
        let n2 = upsert_usage_history(&path, &batch).unwrap();
        assert_eq!(n2, 2, "总条数不变");
        assert_eq!(
            fs::read(&path).unwrap(),
            bytes1,
            "同批次重复 upsert 字节必须不变"
        );
        assert_eq!(
            fs::metadata(&path).unwrap().modified().unwrap(),
            mtime1,
            "内容全等时不得写盘（mtime 不变）"
        );
    }

    /// §1.3 / AC-4：site 覆盖 local；local **永不**覆盖 site（站点窗口后移即为升级）
    #[test]
    fn test_upsert_site_covers_local_and_local_never_covers_site() {
        let path = usage_temp_path("usage-site-priority");
        let _ = fs::remove_file(&path);

        upsert_usage_history(&path, &[rec("a1", "2026-10-15", Some(20.0), "local")]).unwrap();
        upsert_usage_history(&path, &[rec("a1", "2026-10-15", Some(5.0), "site")]).unwrap();
        let after_site = load_usage_history(&path).unwrap();
        assert_eq!(after_site.records.len(), 1, "同键不得产生重复行");
        assert_eq!(after_site.records[0].cost, Some(5.0), "站点应覆盖本地估算");
        assert_eq!(after_site.records[0].source, "site");

        // 本地值更大也不得回退站点行
        upsert_usage_history(&path, &[rec("a1", "2026-10-15", Some(99.0), "local")]).unwrap();
        let after_local = load_usage_history(&path).unwrap();
        assert_eq!(after_local.records.len(), 1);
        assert_eq!(
            after_local.records[0].cost,
            Some(5.0),
            "local 永不覆盖 site"
        );
        assert_eq!(after_local.records[0].source, "site");
    }

    /// §1.3：同 source 同键 → 新值覆盖；跨日 → 追加
    #[test]
    fn test_upsert_same_source_newest_wins_and_cross_day_appends() {
        let path = usage_temp_path("usage-merge");
        let _ = fs::remove_file(&path);

        upsert_usage_history(&path, &[rec("a1", "2026-10-15", Some(20.0), "local")]).unwrap();
        upsert_usage_history(&path, &[rec("a1", "2026-10-15", Some(30.0), "local")]).unwrap();
        let same_day = load_usage_history(&path).unwrap();
        assert_eq!(same_day.records.len(), 1, "同日同源只保留一行");
        assert_eq!(same_day.records[0].cost, Some(30.0), "新批次覆盖旧值");

        upsert_usage_history(&path, &[rec("a1", "2026-10-16", Some(1.0), "local")]).unwrap();
        let cross_day = load_usage_history(&path).unwrap();
        assert_eq!(cross_day.records.len(), 2, "跨日应追加");
        assert_eq!(
            cross_day
                .records
                .iter()
                .map(|r| r.date.clone())
                .collect::<Vec<_>>(),
            vec!["2026-10-15".to_string(), "2026-10-16".to_string()],
            "落盘顺序按 (accountId, date) 升序"
        );
    }

    /// §1.4 ① / AC-7：单账号 401 天 → 只留最近 400 天（最旧消失、最新仍在），其他账号不受影响
    #[test]
    fn test_trim_keeps_latest_400_days_per_account() {
        let mut records: Vec<UsageRecord> = (0..401)
            .map(|i| rec("a1", &day(i), Some(1.0), "site"))
            .collect();
        records.push(rec("a2", &day(0), Some(2.0), "site"));

        trim_usage_records(&mut records);

        let a1: Vec<&UsageRecord> = records.iter().filter(|r| r.account_id == "a1").collect();
        assert_eq!(a1.len(), 400);
        assert!(!a1.iter().any(|r| r.date == day(0)), "最旧一天应被丢弃");
        assert!(a1.iter().any(|r| r.date == day(400)), "最新一天必须保留");
        assert!(
            records.iter().any(|r| r.account_id == "a2"),
            "其他账号不应被误删"
        );
    }

    /// §1.4 ② / AC-7：总量 20001 → 裁到 20000，丢的是最旧 (date, accountId)
    #[test]
    fn test_trim_global_cap_drops_oldest() {
        let mut records: Vec<UsageRecord> = (0..=MAX_USAGE_RECORDS)
            .map(|i| {
                rec(
                    &format!("a{:03}", i % 51),
                    &day((i / 51) as i64),
                    Some(1.0),
                    "site",
                )
            })
            .collect();
        assert_eq!(records.len(), MAX_USAGE_RECORDS + 1);
        // 每账号 <= 393 天，所以只可能触发全局上限
        let max_dates = records.iter().filter(|r| r.account_id == "a000").count();
        assert!(max_dates <= MAX_USAGE_DAYS_PER_ACCOUNT);

        trim_usage_records(&mut records);

        assert_eq!(records.len(), MAX_USAGE_RECORDS);
        assert!(
            !records
                .iter()
                .any(|r| r.account_id == "a000" && r.date == day(0)),
            "最旧的 (date, accountId) 应被丢弃"
        );
        assert!(
            records.iter().any(|r| r.date == day(392)),
            "最新日期必须保留"
        );
        assert_eq!(
            records.iter().filter(|r| r.date == day(0)).count(),
            50,
            "同日只丢一条"
        );
    }

    /// §1.5 读路径 / AC-8：损坏 → 可读中文 Err，且**不移动、不改写**原文件、不产生备份
    #[test]
    fn test_load_corrupt_returns_readable_error_without_touching_file() {
        let path = usage_temp_path("usage-corrupt-read");
        let _ = fs::remove_file(&path);
        fs::write(&path, "###").unwrap();

        let err = load_usage_history(&path).expect_err("损坏文件必须报错");
        assert!(err.contains("用量历史文件格式错误"), "错误应可读: {err}");
        assert!(
            err.contains("usage-history.json"),
            "错误应带文件路径: {err}"
        );
        assert!(path.exists(), "读路径不得移动/删除文件");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "###",
            "读路径不得改写文件"
        );
        assert!(corrupt_backups(&path).is_empty(), "读路径不得产生备份");
    }

    /// §1.5 写路径 / AC-8：upsert 遇损坏 → 先备份为 usage-history.corrupt-*.json，再用本批重建
    #[test]
    fn test_upsert_self_heals_corrupt_file_after_backup() {
        let path = usage_temp_path("usage-corrupt-write");
        let _ = fs::remove_file(&path);
        fs::write(&path, "###").unwrap();

        let n = upsert_usage_history(&path, &[rec("a1", "2026-10-15", Some(3.0), "site")]).unwrap();
        assert_eq!(n, 1, "自愈后文件应由本批记录重建");

        let healed = load_usage_history(&path).unwrap();
        assert_eq!(healed.version, 1);
        assert_eq!(healed.records.len(), 1);
        assert_eq!(healed.records[0].cost, Some(3.0));

        let backups = corrupt_backups(&path);
        assert_eq!(backups.len(), 1, "必须产生且只产生一个备份");
        assert_eq!(
            fs::read_to_string(&backups[0]).unwrap(),
            "###",
            "备份必须保留原始损坏内容（用户历史可找回）"
        );
    }

    /// §1.5：version > 1 → 返回 Err 且**不覆盖**原文件；读路径同样拒绝
    #[test]
    fn test_future_version_is_rejected_without_overwrite() {
        let path = usage_temp_path("usage-future-version");
        let _ = fs::remove_file(&path);
        let original = r#"{"version":2,"records":[]}"#;
        fs::write(&path, original).unwrap();

        let err = upsert_usage_history(&path, &[rec("a1", "2026-10-15", Some(1.0), "site")])
            .expect_err("未来版本必须拒绝");
        assert!(err.contains("版本"), "错误应可读: {err}");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            original,
            "不得覆盖未来版本数据"
        );
        assert!(corrupt_backups(&path).is_empty(), "版本过高不应备份");

        let read_err = load_usage_history(&path).expect_err("读路径也应拒绝");
        assert!(read_err.contains("版本"), "错误应可读: {read_err}");
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
    }

    /// 写失败（父路径是文件）→ 可读中文 Err，不 panic；且不残留 .tmp
    #[test]
    fn test_upsert_write_failure_returns_readable_error() {
        let tag_path = temp_config_path("usage-write-fail");
        let dir = tag_path.parent().unwrap().to_path_buf();
        let blocker = dir.join("blocker-file");
        fs::write(&blocker, "x").unwrap();
        let path = blocker.join("usage-history.json");

        let err = upsert_usage_history(&path, &[rec("a1", "2026-10-15", Some(1.0), "site")])
            .expect_err("写失败应返回错误而不是 panic");
        assert!(err.contains("用量历史"), "错误应可读: {err}");
        assert_eq!(fs::read_to_string(&blocker).unwrap(), "x");
        let _ = fs::remove_file(&blocker);
    }

    /// 原子写不残留 `.tmp`
    #[test]
    fn test_usage_history_atomic_write_leaves_no_tmp() {
        let path = usage_temp_path("usage-tmp");
        let _ = fs::remove_file(&path);
        upsert_usage_history(&path, &[rec("a1", "2026-10-15", Some(1.0), "site")]).unwrap();
        assert!(
            !path.with_file_name("usage-history.json.tmp").exists(),
            "不应残留临时文件"
        );
        assert!(path.exists());
    }

    /// §1.6 / AC-9：credits 币种原值保留，Rust 不做任何换算
    #[test]
    fn test_upsert_preserves_currency_verbatim() {
        let path = usage_temp_path("usage-credits");
        let _ = fs::remove_file(&path);
        let mut credits = rec("kimi", "2026-10-15", None, "local");
        credits.currency = "CREDITS".into();
        credits.requests = None;
        credits.used_total = Some(1234.0);
        credits.tokens = None;

        upsert_usage_history(&path, &[credits]).unwrap();

        let file = load_usage_history(&path).unwrap();
        assert_eq!(file.records.len(), 1);
        assert_eq!(file.records[0].currency, "CREDITS", "不得换算或改写币种");
        assert_eq!(file.records[0].cost, None);
        assert_eq!(
            file.records[0].used_total,
            Some(1234.0),
            "B2 增量基准必须落盘"
        );
    }

    /// 空批次 + 文件不存在 → 返回 0 且**不创建**文件；文件已存在 → 内容与 mtime 均不变
    #[test]
    fn test_upsert_empty_batch_does_not_create_file() {
        let path = usage_temp_path("usage-empty-batch");
        let _ = fs::remove_file(&path);

        let n = upsert_usage_history(&path, &[]).unwrap();
        assert_eq!(n, 0);
        assert!(!path.exists(), "空批次且文件不存在时不得创建空文件");

        // 文件已存在（合法封套）→ 空批次不改变文件
        let n = upsert_usage_history(&path, &[rec("a1", "2026-10-15", Some(1.0), "site")]).unwrap();
        assert_eq!(n, 1);
        let bytes = fs::read(&path).unwrap();
        let mtime = fs::metadata(&path).unwrap().modified().unwrap();

        std::thread::sleep(std::time::Duration::from_millis(25));
        let n = upsert_usage_history(&path, &[]).unwrap();
        assert_eq!(n, 1, "空批次不改变总条数");
        assert_eq!(fs::read(&path).unwrap(), bytes, "空批次不得改变文件字节");
        assert_eq!(
            fs::metadata(&path).unwrap().modified().unwrap(),
            mtime,
            "空批次不得写盘"
        );
    }

    /// §1.1 兜底：写入时空币种 → `UNKNOWN`、首尾空白被 trim；**不改大小写**
    #[test]
    fn test_upsert_normalizes_blank_currency_to_unknown() {
        let path = usage_temp_path("usage-currency-fallback");
        let _ = fs::remove_file(&path);

        let mut blank = rec("a1", "2026-10-15", Some(1.0), "site");
        blank.currency = "   ".into();
        let mut empty = rec("a2", "2026-10-15", Some(2.0), "local");
        empty.currency = String::new();
        let mut padded = rec("a3", "2026-10-15", Some(3.0), "site");
        padded.currency = "usd ".into();

        upsert_usage_history(&path, &[blank, empty, padded]).unwrap();

        let file = load_usage_history(&path).unwrap();
        let currency_of = |account: &str| {
            file.records
                .iter()
                .find(|r| r.account_id == account)
                .map(|r| r.currency.clone())
                .unwrap()
        };
        assert_eq!(currency_of("a1"), "UNKNOWN", "纯空白应兜底为 UNKNOWN");
        assert_eq!(currency_of("a2"), "UNKNOWN", "空串应兜底为 UNKNOWN");
        assert_eq!(currency_of("a3"), "usd", "只 trim，不做大小写归一");

        // 既有行里的空币种也会在下次写入时被修复（文件不变量：永不空串）
        let mut dirty = load_usage_history(&path).unwrap();
        dirty
            .records
            .iter_mut()
            .find(|r| r.account_id == "a1")
            .unwrap()
            .currency = String::new();
        let text = serde_json::to_string_pretty(&dirty).unwrap();
        fs::write(&path, text).unwrap();

        upsert_usage_history(&path, &[rec("a4", "2026-10-16", Some(4.0), "site")]).unwrap();
        let repaired = load_usage_history(&path).unwrap();
        assert_eq!(
            repaired
                .records
                .iter()
                .find(|r| r.account_id == "a1")
                .unwrap()
                .currency,
            "UNKNOWN",
            "既有行的空币种也应在写入时被兜底修复"
        );
    }

    /// 落盘顺序稳定：无论批次顺序如何，文件内按 (accountId, date) 升序
    #[test]
    fn test_usage_history_order_is_stable() {
        let path = usage_temp_path("usage-order");
        let _ = fs::remove_file(&path);
        upsert_usage_history(
            &path,
            &[
                rec("b", "2026-10-16", Some(1.0), "site"),
                rec("a", "2026-10-16", Some(1.0), "site"),
                rec("a", "2026-10-14", Some(1.0), "site"),
            ],
        )
        .unwrap();

        let file = load_usage_history(&path).unwrap();
        let keys: Vec<(String, String)> = file
            .records
            .iter()
            .map(|r| (r.account_id.clone(), r.date.clone()))
            .collect();
        assert_eq!(
            keys,
            vec![
                ("a".to_string(), "2026-10-14".to_string()),
                ("a".to_string(), "2026-10-16".to_string()),
                ("b".to_string(), "2026-10-16".to_string()),
            ]
        );
    }

    /// D-3：未知/空/大小写不匹配的 `source` 降级为 `local`（绝不冒充 site），
    /// 且脏值**不得覆盖**既有 site 权威行
    #[test]
    fn test_upsert_normalizes_unknown_source_without_covering_site() {
        let path = usage_temp_path("usage-source-fallback");
        let _ = fs::remove_file(&path);

        // 一条真正的 site 权威行
        upsert_usage_history(&path, &[rec("a1", "2026-10-15", Some(5.0), "site")]).unwrap();

        // 脏 source 批次：同键想覆盖 site，另有两条新键
        let mut junk_same_key = rec("a1", "2026-10-15", Some(99.0), "foo");
        junk_same_key.source = "foo".into();
        let mut blank = rec("a2", "2026-10-15", Some(1.0), "");
        blank.source = String::new();
        let mut upper = rec("a3", "2026-10-15", Some(2.0), "SITE");
        upper.source = "SITE".into();
        let batch = vec![junk_same_key, blank, upper];

        let total = upsert_usage_history(&path, &batch).unwrap();
        assert_eq!(total, 3);

        let file = load_usage_history(&path).unwrap();
        let find = |account: &str| {
            file.records
                .iter()
                .find(|r| r.account_id == account)
                .unwrap()
        };
        let site_row = find("a1");
        assert_eq!(site_row.cost, Some(5.0), "脏 source 不得覆盖既有 site 行");
        assert_eq!(site_row.source, "site");
        assert_eq!(find("a2").source, "local", "空 source 应降级为 local");
        assert_eq!(
            find("a3").source,
            "local",
            "SITE 大小写不匹配也应降级，不得冒充 site"
        );
        // 降级后的行内容本身保留（只有 source 被改写）
        assert_eq!(find("a3").cost, Some(2.0));

        // 同一批脏值再来一次：内容已归一，必须字节幂等
        let bytes = fs::read(&path).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));
        let total_again = upsert_usage_history(&path, &batch).unwrap();
        assert_eq!(total_again, 3);
        assert_eq!(
            fs::read(&path).unwrap(),
            bytes,
            "归一后重复 upsert 必须字节不变"
        );
    }

    /// D-5：同秒备份名已存在 → 落到 `-1` 后缀，**绝不覆盖**既有备份，两份内容各自保留
    #[test]
    fn test_backup_name_collision_uses_suffix_and_keeps_existing() {
        let path = usage_temp_path("usage-backup-collision");
        let _ = fs::remove_file(&path);
        let dir = path.parent().unwrap().to_path_buf();
        // 清掉同目录历史备份，避免干扰断言
        for entry in fs::read_dir(&dir).unwrap() {
            let p = entry.unwrap().path();
            if p.file_name()
                .map(|n| n.to_string_lossy().starts_with("usage-history.corrupt-"))
                .unwrap_or(false)
            {
                let _ = fs::remove_file(&p);
            }
        }

        // 占住「当前秒 ±1」的裸名备份位 —— 无论实现取哪一秒，裸名都已被占用，
        // 从而确定性地走到 `-1` 后缀分支（不依赖测试与实现恰好同秒）
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let mut decoys: Vec<(PathBuf, String)> = Vec::new();
        for offset in [-1i64, 0, 1] {
            let s = (secs + offset) as u64;
            let content = format!("PRE-EXISTING-{s}");
            let decoy = path.with_file_name(format!("usage-history.corrupt-{s}.json"));
            fs::write(&decoy, &content).unwrap();
            decoys.push((decoy, content));
        }

        // 损坏文件 → upsert 必须先备份再自愈
        fs::write(&path, "###").unwrap();
        let n = upsert_usage_history(&path, &[rec("a1", "2026-10-15", Some(3.0), "site")]).unwrap();
        assert_eq!(n, 1);

        // 既有备份必须原样保留（不覆盖、不删除）
        for (decoy, expected) in &decoys {
            assert!(decoy.exists(), "既有备份不得被覆盖: {}", decoy.display());
            assert_eq!(
                &fs::read_to_string(decoy).unwrap(),
                expected,
                "既有备份内容必须原样保留"
            );
        }

        // 新备份必须落到 `-1` 后缀名，并保留原始损坏内容
        let suffixed: Vec<PathBuf> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().ends_with("-1.json"))
                    .unwrap_or(false)
            })
            .collect();
        assert_eq!(
            suffixed.len(),
            1,
            "应恰好产生一个 -1 后缀备份: {suffixed:?}"
        );
        assert_eq!(
            fs::read_to_string(&suffixed[0]).unwrap(),
            "###",
            "新备份必须保留原始损坏内容"
        );

        // 自愈结果仍可读
        let healed = load_usage_history(&path).unwrap();
        assert_eq!(healed.records.len(), 1);
        assert_eq!(healed.records[0].cost, Some(3.0));
    }

    // ---------- R16 §7 全空行兜底 ----------

    /// 构造一条「六字段全 null」的全空行
    fn empty_row(account: &str, date: &str) -> UsageRecord {
        UsageRecord {
            account_id: account.into(),
            date: date.into(),
            cost: None,
            currency: "USD".into(),
            requests: None,
            input_tokens: None,
            output_tokens: None,
            tokens: None,
            used_total: None,
            source: "site".into(),
            updated_at: "2026-10-15T10:00:00+08:00".into(),
        }
    }

    /// 纯函数：全空行删除，但只要任一字段有值就保留（含 B2 基准行 usedTotal）
    #[test]
    fn test_drop_empty_usage_records_keeps_b2_baseline() {
        let mut records = vec![
            empty_row("a1", "2026-10-15"),
            UsageRecord {
                tokens: Some(0.0),
                ..empty_row("a2", "2026-10-15")
            },
            UsageRecord {
                cost: Some(0.0),
                ..empty_row("a3", "2026-10-15")
            },
            UsageRecord {
                requests: Some(0),
                ..empty_row("a4", "2026-10-15")
            },
            UsageRecord {
                used_total: Some(123.0),
                ..empty_row("kimi", "2026-10-15")
            },
        ];
        drop_empty_usage_records(&mut records);
        let ids: Vec<&str> = records.iter().map(|r| r.account_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["a2", "a3", "a4", "kimi"],
            "只删全空行；0 值字段与 usedTotal 基准行都要保留"
        );
    }

    /// AC-20：绕过前端直接传全空行 → 落盘后文件内无全空行，重复 upsert 幂等
    #[test]
    fn test_upsert_drops_all_empty_rows_from_batch() {
        let path = usage_temp_path("usage-empty-row-batch");
        let _ = fs::remove_file(&path);

        let batch = vec![
            empty_row("a1", "2026-10-15"),
            empty_row("a2", "2026-10-16"),
            rec("a3", "2026-10-17", Some(1.5), "site"),
        ];
        let total = upsert_usage_history(&path, &batch).unwrap();
        assert_eq!(total, 1, "两条全空行应被丢弃");

        let file = load_usage_history(&path).unwrap();
        assert_eq!(file.records.len(), 1);
        assert_eq!(file.records[0].account_id, "a3");

        // 幂等：同一批（含全空行）再来一次，字节不变
        let bytes = fs::read(&path).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(25));
        assert_eq!(upsert_usage_history(&path, &batch).unwrap(), 1);
        assert_eq!(fs::read(&path).unwrap(), bytes);
    }

    /// AC-20：整账里的历史全空行也会在写入时被净化（与币种/source 归一同一策略）
    #[test]
    fn test_upsert_purges_existing_empty_rows_in_ledger() {
        let path = usage_temp_path("usage-empty-row-ledger");
        let _ = fs::remove_file(&path);

        // 手工构造一个「含全空行」的历史文件（模拟旧版本/脏数据写入的产物）
        let dirty = UsageHistoryFile {
            version: 1,
            records: vec![
                empty_row("ghost", "2026-10-01"),
                rec("keep", "2026-10-02", Some(2.0), "site"),
            ],
        };
        fs::write(&path, serde_json::to_string_pretty(&dirty).unwrap()).unwrap();

        upsert_usage_history(&path, &[rec("new", "2026-10-03", Some(3.0), "site")]).unwrap();

        let file = load_usage_history(&path).unwrap();
        let ids: Vec<&str> = file.records.iter().map(|r| r.account_id.as_str()).collect();
        assert_eq!(ids, vec!["keep", "new"], "既有全空行应被清除");
    }

    /// AC-20 边界：批次非空但全是被过滤的空行、且文件不存在 → 不创建空文件
    #[test]
    fn test_upsert_all_empty_batch_creates_no_file() {
        let path = usage_temp_path("usage-empty-row-nofile");
        let _ = fs::remove_file(&path);

        let total = upsert_usage_history(
            &path,
            &[empty_row("a1", "2026-10-15"), empty_row("a2", "2026-10-15")],
        )
        .unwrap();
        assert_eq!(total, 0);
        assert!(!path.exists(), "净化后一条不剩时不得创建空文件");
    }
}

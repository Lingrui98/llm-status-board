use serde::{Deserialize, Serialize};

// ---------- 基础 ----------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyValue {
    pub key: String,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Money {
    pub amount: f64,
    pub currency: String,
}

// ---------- 提供商类型 ----------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    OneApi,
    NewApi,
    Sub2Api,
    ModelServer,
    AiHubMix,
    DeepSeek,
    OpenAi,
    SiliconFlow,
    Moonshot,
    Zhipu,
    DashScope,
    Custom,
}

// ---------- 自定义查询 ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomQuery {
    pub method: String,
    pub url: String,
    pub headers: Vec<KeyValue>,
    pub body: Option<String>,
    pub balance_path: Option<String>,
    pub used_path: Option<String>,
    pub total_path: Option<String>,
    pub currency_path: Option<String>,
    pub currency: Option<String>,
    pub scale: Option<f64>,
    pub extra_paths: Vec<KeyValue>,
}

impl Default for CustomQuery {
    fn default() -> Self {
        Self {
            method: "GET".into(),
            url: String::new(),
            headers: Vec::new(),
            body: None,
            balance_path: None,
            used_path: None,
            total_path: None,
            currency_path: None,
            currency: None,
            scale: None,
            extra_paths: Vec::new(),
        }
    }
}

// ---------- 账号 ----------

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AccountConfig {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    #[serde(default = "default_true")]
    pub enabled: bool,
    pub base_url: String,
    pub api_key: String,
    pub token: String,
    pub refresh_token: String,
    pub user_id: Option<i64>,
    pub username: String,
    pub password: String,
    pub quota_per_unit: Option<f64>,
    pub custom: Option<CustomQuery>,
}

impl Default for AccountConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            kind: ProviderKind::NewApi,
            enabled: true,
            base_url: String::new(),
            api_key: String::new(),
            token: String::new(),
            refresh_token: String::new(),
            user_id: None,
            username: String::new(),
            password: String::new(),
            quota_per_unit: None,
            custom: None,
        }
    }
}

impl AccountConfig {
    /// 去掉末尾斜杠的 base url
    pub fn base(&self) -> String {
        self.base_url.trim().trim_end_matches('/').to_string()
    }

    pub fn quota_per_unit_value(&self) -> f64 {
        let v = self.quota_per_unit.unwrap_or(500_000.0);
        if v > 0.0 {
            v
        } else {
            500_000.0
        }
    }
}

// ---------- 配置 ----------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub auto_refresh_sec: u32,
    pub refresh_on_start: bool,
    /// 全局代理（http://… 或 socks5://…），留空用环境变量
    pub proxy: Option<String>,
    /// 关闭窗口时隐藏到系统托盘；None 视为 true（向后兼容旧配置文件）
    pub close_to_tray: Option<bool>,
    // ---- R14 提醒与洞察（全部 Option + serde default，旧 config.json 无迁移即可加载）----
    /// 是否启用余额/配额提醒；None 视为 true
    pub notify_enabled: Option<bool>,
    /// 低余额提醒线（USD 及其他法币）；None 视为 1，取值 0..=10000
    pub notify_low_balance_usd: Option<f64>,
    /// 低余额提醒线（CNY/RMB/CNH）；None 视为 7，取值 0..=100000
    pub notify_low_balance_cny: Option<f64>,
    /// 配额用量提醒线（%）；None 视为 85，取值 1..=100 的整数
    pub notify_quota_percent: Option<f64>,
    /// 洞察统计窗口（天）；None 视为 14，取值 3..=90 的整数
    pub insight_window_days: Option<u32>,
    // ---- R16 常驻与自动化（同样 Option + serde default）----
    /// 是否推送系统通知；None 视为 **false**（默认关，避免未授权就弹窗）
    pub system_notifications: Option<bool>,
    /// 刷新整轮失败时是否自动重试；None 视为 true
    pub refresh_retry_enabled: Option<bool>,
    /// 自动重试的最大次数；None 视为 1，取值 0..=3
    pub refresh_retry_max: Option<u32>,
    // ---- R22 一键更新 ----
    /// 启动时是否静默检查更新（只提示不下载）；None 视为 true
    pub auto_check_update: Option<bool>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_refresh_sec: 0,
            refresh_on_start: true,
            proxy: None,
            close_to_tray: None,
            notify_enabled: None,
            notify_low_balance_usd: None,
            notify_low_balance_cny: None,
            notify_quota_percent: None,
            insight_window_days: None,
            system_notifications: None,
            refresh_retry_enabled: None,
            refresh_retry_max: None,
            auto_check_update: None,
        }
    }
}

/// R14 提醒与洞察设置的取值范围（None = 用默认，跳过校验）
pub const NOTIFY_LOW_BALANCE_USD_RANGE: (f64, f64) = (0.0, 10_000.0);
pub const NOTIFY_LOW_BALANCE_CNY_RANGE: (f64, f64) = (0.0, 100_000.0);
pub const NOTIFY_QUOTA_PERCENT_RANGE: (f64, f64) = (1.0, 100.0);
pub const INSIGHT_WINDOW_DAYS_RANGE: (u32, u32) = (3, 90);
/// R16 §1：自动重试次数范围（0 = 不重试）
pub const REFRESH_RETRY_MAX_RANGE: (u32, u32) = (0, 3);

/// 服务端范围校验（AC-9 的后端保障）：越界返回**可读中文错误**，全部合法返回 Ok。
///
/// 纯函数，便于单测；`None` 表示「使用默认值」，一律视为合法。
pub fn validate_settings(settings: &Settings) -> Result<(), String> {
    if let Some(v) = settings.notify_low_balance_usd {
        check_number(
            v,
            NOTIFY_LOW_BALANCE_USD_RANGE,
            "低余额提醒阈值（USD）",
            false,
        )?;
    }
    if let Some(v) = settings.notify_low_balance_cny {
        check_number(
            v,
            NOTIFY_LOW_BALANCE_CNY_RANGE,
            "低余额提醒阈值（CNY）",
            false,
        )?;
    }
    if let Some(v) = settings.notify_quota_percent {
        check_number(v, NOTIFY_QUOTA_PERCENT_RANGE, "配额用量提醒线", true)?;
    }
    if let Some(v) = settings.insight_window_days {
        let (min, max) = INSIGHT_WINDOW_DAYS_RANGE;
        if v < min || v > max {
            return Err(format!(
                "洞察统计窗口（天）必须在 {min}–{max} 之间，当前为 {v}"
            ));
        }
    }
    // R16 §1：自动重试次数（u32，天然是整数）
    if let Some(v) = settings.refresh_retry_max {
        let (min, max) = REFRESH_RETRY_MAX_RANGE;
        if v < min || v > max {
            return Err(format!("刷新重试次数必须在 {min}–{max} 之间，当前为 {v}"));
        }
    }
    Ok(())
}

/// 数值范围 + 可选整数要求；`NaN`/`Infinity` 一律拒绝
fn check_number(
    v: f64,
    (min, max): (f64, f64),
    label: &str,
    require_integer: bool,
) -> Result<(), String> {
    if !v.is_finite() {
        return Err(format!("{label}必须是有效数字"));
    }
    if require_integer && v.fract() != 0.0 {
        return Err(format!("{label}必须是整数，当前为 {v}"));
    }
    if v < min || v > max {
        return Err(format!("{label}必须在 {min}–{max} 之间，当前为 {v}"));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppConfig {
    pub version: u32,
    pub settings: Settings,
    pub accounts: Vec<AccountConfig>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            version: 1,
            settings: Settings::default(),
            accounts: Vec::new(),
        }
    }
}

// ---------- 查询结果 ----------

/// 单个用量数据点（按日或按模型聚合）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UsagePoint {
    /// 按日聚合时的日期（YYYY-MM-DD）
    pub date: Option<String>,
    /// 按模型聚合时的模型名
    pub model: Option<String>,
    pub requests: Option<i64>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub tokens: Option<f64>,
    /// 花费（配 cost_unit）
    pub cost: Option<f64>,
    /// 花费单位（"USD" / "CNY" / "credits"）
    pub cost_unit: Option<String>,
    pub latency_ms: Option<f64>,
}

/// 配额窗口（5h / 1d / 7d 等）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct QuotaWindow {
    /// 窗口标识（five_hour / seven_day / 5h / 1d / 7d…）
    pub window: Option<String>,
    /// 已用百分比（0-100）
    pub used_percent: Option<f64>,
    /// 重置时间（ISO8601）
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct AccountInfo {
    pub balance: Option<Money>,
    pub used: Option<Money>,
    pub total: Option<Money>,
    pub requests: Option<i64>,
    pub note: Option<String>,
    pub extras: Vec<KeyValue>,
    pub raw: Option<serde_json::Value>,
    pub fetched_at: String,
    /// provider 轮换出的新 token（回写配置 / 表单用）
    pub new_token: Option<String>,
    pub new_refresh_token: Option<String>,
    /// 按日用量（统计图用）
    #[serde(default)]
    pub daily_usage: Vec<UsagePoint>,
    /// 按模型用量（统计图用）
    #[serde(default)]
    pub model_usage: Vec<UsagePoint>,
    /// 配额窗口（进度条用）
    #[serde(default)]
    pub quota_windows: Vec<QuotaWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshOutcome {
    pub account_id: String,
    pub ok: bool,
    pub info: Option<AccountInfo>,
    pub error: Option<String>,
}

/// 余额与总额度历史快照；旧记录缺少 total 时仍可直接读取。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceSnapshot {
    /// 刷新时间（ISO8601）
    pub ts: String,
    pub account_id: String,
    pub balance: f64,
    pub currency: String,
    /// 与余额同币种的总额度；不从余额推算或补填旧记录。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total: Option<f64>,
}

// ---------- 本地用量历史（R15 usage-history.json） ----------

/// `usage-history.json` 当前版本（§1.1 版本封套，便于将来迁移）
pub const USAGE_HISTORY_VERSION: u32 = 1;

/// 记录来源：站点权威数据（§1.2 A）。只有前端明确写 `"site"` 才算权威
/// （`is_site()` 是严格相等，不做大小写/去空白容错）。
pub const USAGE_SOURCE_SITE: &str = "site";
/// 记录来源：本地估算（§1.2 B1 余额下降法 / B2 used 计数器法）；
/// 也是未知/空/大小写不匹配 source 的降级目标（见 `config::normalize_usage_source`）
pub const USAGE_SOURCE_LOCAL: &str = "local";

/// `currency` 归一缺失时的兜底取值（§1.1 声明「永不空串」）
pub const USAGE_CURRENCY_UNKNOWN: &str = "UNKNOWN";

fn default_usage_history_version() -> u32 {
    USAGE_HISTORY_VERSION
}

/// `usage-history.json` 顶层结构（R15 §1.1；**带版本封套，不是裸数组**）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistoryFile {
    #[serde(default = "default_usage_history_version")]
    pub version: u32,
    #[serde(default)]
    pub records: Vec<UsageRecord>,
}

impl Default for UsageHistoryFile {
    fn default() -> Self {
        Self {
            version: USAGE_HISTORY_VERSION,
            records: Vec::new(),
        }
    }
}

/// 单条逐日用量记录，键 = `(accountId, date)`（R15 §1.1）。
/// 所有字段都带 serde default：缺字段的文件仍能读，不会因单条脏数据整文件报废。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageRecord {
    /// 账号 id（不存名字，改名不影响历史）
    pub account_id: String,
    /// 本地日历日 `YYYY-MM-DD`
    pub date: String,
    /// 当日花费（站点值或本地估算；无则 null）
    pub cost: Option<f64>,
    /// 归一币种（USD/CNY/CREDITS/UNKNOWN…）。**由前端归一，Rust 原样保存不换算**
    pub currency: String,
    pub requests: Option<i64>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub tokens: Option<f64>,
    /// 仅 §1.2 B2（used 计数器法）使用，其余路径为 null
    pub used_total: Option<f64>,
    /// `"site"` 或 `"local"`
    pub source: String,
    /// 写入时刻（`now_iso()`，本地 RFC3339 带偏移）
    pub updated_at: String,
}

impl UsageRecord {
    /// 是否站点（权威）行
    pub fn is_site(&self) -> bool {
        self.source == USAGE_SOURCE_SITE
    }
}

pub fn now_iso() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 旧配置（完全没有 R14 的 5 个字段）反序列化后应为 None（= 前端按默认值工作）
    #[test]
    fn legacy_settings_json_without_r14_fields_loads_as_none() {
        let legacy =
            r#"{"autoRefreshSec":300,"refreshOnStart":true,"proxy":null,"closeToTray":false}"#;
        let s: Settings = serde_json::from_str(legacy).expect("旧 settings 应可反序列化");
        assert_eq!(s.auto_refresh_sec, 300);
        assert_eq!(s.close_to_tray, Some(false));
        assert_eq!(s.notify_enabled, None);
        assert_eq!(s.notify_low_balance_usd, None);
        assert_eq!(s.notify_low_balance_cny, None);
        assert_eq!(s.notify_quota_percent, None);
        assert_eq!(s.insight_window_days, None);
    }

    /// 5 个新字段的 camelCase 名称、类型与往返一致性
    #[test]
    fn r14_settings_fields_round_trip() {
        let json = r#"{
            "notifyEnabled": false,
            "notifyLowBalanceUsd": 12.5,
            "notifyLowBalanceCny": 88.0,
            "notifyQuotaPercent": 90,
            "insightWindowDays": 30
        }"#;
        let s: Settings = serde_json::from_str(json).expect("新字段应可反序列化");
        assert_eq!(s.notify_enabled, Some(false));
        assert_eq!(s.notify_low_balance_usd, Some(12.5));
        assert_eq!(s.notify_low_balance_cny, Some(88.0));
        assert_eq!(s.notify_quota_percent, Some(90.0));
        assert_eq!(s.insight_window_days, Some(30));

        // 序列化回去仍是 camelCase，且不出现 snake_case 键名
        let back = serde_json::to_string(&s).unwrap();
        assert!(
            back.contains("\"notifyLowBalanceUsd\":12.5"),
            "实际: {back}"
        );
        assert!(back.contains("\"notifyQuotaPercent\":90.0"));
        assert!(back.contains("\"insightWindowDays\":30"));
        assert!(!back.contains("notify_low_balance_usd"));

        // 二次往返不丢字段
        let again: Settings = serde_json::from_str(&back).unwrap();
        assert_eq!(again.insight_window_days, Some(30));
        assert_eq!(again.notify_enabled, Some(false));
    }

    /// 部分字段缺失时只缺失的为 None，已有值不受影响
    #[test]
    fn partially_present_r14_fields_keep_values() {
        let json = r#"{"notifyLowBalanceUsd": 5.5}"#;
        let s: Settings = serde_json::from_str(json).unwrap();
        assert_eq!(s.notify_low_balance_usd, Some(5.5));
        assert_eq!(s.notify_low_balance_cny, None);
        assert_eq!(s.notify_enabled, None);
        // 其余既有字段仍取 default
        assert!(s.refresh_on_start);
        assert_eq!(s.auto_refresh_sec, 0);
    }

    /// 边界值必须被接受：USD 0/10000、CNY 0/100000、配额 1/100、窗口 3/90
    #[test]
    fn validate_settings_accepts_boundaries_and_none() {
        // 全 None（旧配置升级路径）必须通过
        assert!(validate_settings(&Settings::default()).is_ok());

        let accept =
            |s: Settings| validate_settings(&s).unwrap_or_else(|e| panic!("应被接受: {e}"));

        accept(Settings {
            notify_low_balance_usd: Some(0.0),
            notify_low_balance_cny: Some(0.0),
            notify_quota_percent: Some(1.0),
            insight_window_days: Some(3),
            ..Default::default()
        });
        accept(Settings {
            notify_low_balance_usd: Some(10_000.0),
            notify_low_balance_cny: Some(100_000.0),
            notify_quota_percent: Some(100.0),
            insight_window_days: Some(90),
            ..Default::default()
        });
        accept(Settings {
            notify_enabled: Some(false),
            notify_quota_percent: Some(85.0),
            insight_window_days: Some(14),
            ..Default::default()
        });
    }

    /// 越界值必须被拒绝，且错误信息是可读中文并点出范围
    #[test]
    fn validate_settings_rejects_out_of_range() {
        let cases: Vec<(Settings, &str)> = vec![
            (
                Settings {
                    notify_low_balance_usd: Some(10_000.5),
                    ..Default::default()
                },
                "低余额提醒阈值（USD）",
            ),
            (
                Settings {
                    notify_low_balance_usd: Some(-0.1),
                    ..Default::default()
                },
                "低余额提醒阈值（USD）",
            ),
            (
                Settings {
                    notify_low_balance_cny: Some(100_001.0),
                    ..Default::default()
                },
                "低余额提醒阈值（CNY）",
            ),
            (
                Settings {
                    notify_quota_percent: Some(0.5),
                    ..Default::default()
                },
                "配额用量提醒线",
            ),
            (
                Settings {
                    notify_quota_percent: Some(120.0),
                    ..Default::default()
                },
                "配额用量提醒线",
            ),
            (
                Settings {
                    insight_window_days: Some(2),
                    ..Default::default()
                },
                "洞察统计窗口",
            ),
            (
                Settings {
                    insight_window_days: Some(91),
                    ..Default::default()
                },
                "洞察统计窗口",
            ),
        ];
        for (s, label) in cases {
            let err = validate_settings(&s).expect_err("越界值必须被拒绝");
            assert!(err.contains(label), "错误信息应点出字段: {err}");
            assert!(
                err.contains("必须在") || err.contains("必须是"),
                "错误信息应说明要求: {err}"
            );
            assert!(
                err.chars().any(|c| ('\u{4e00}'..='\u{9fff}').contains(&c)),
                "错误信息应为中文: {err}"
            );
        }
    }

    /// 百分数与窗口必须为整数；NaN / Infinity 一律拒绝
    #[test]
    fn validate_settings_rejects_non_integer_and_non_finite() {
        let err = validate_settings(&Settings {
            notify_quota_percent: Some(85.5),
            ..Default::default()
        })
        .expect_err("非整数百分数应被拒绝");
        assert!(err.contains("必须") && err.contains("整数"), "实际: {err}");

        let err = validate_settings(&Settings {
            notify_quota_percent: Some(f64::NAN),
            ..Default::default()
        })
        .expect_err("NaN 应被拒绝");
        assert!(err.contains("有效数字"), "实际: {err}");

        let err = validate_settings(&Settings {
            notify_low_balance_usd: Some(f64::INFINITY),
            ..Default::default()
        })
        .expect_err("Infinity 应被拒绝");
        assert!(err.contains("有效数字"), "实际: {err}");
    }

    /// 阈值范围常量与规格 §3 的表格一致
    #[test]
    fn r14_ranges_match_spec() {
        assert_eq!(NOTIFY_LOW_BALANCE_USD_RANGE, (0.0, 10_000.0));
        assert_eq!(NOTIFY_LOW_BALANCE_CNY_RANGE, (0.0, 100_000.0));
        assert_eq!(NOTIFY_QUOTA_PERCENT_RANGE, (1.0, 100.0));
        assert_eq!(INSIGHT_WINDOW_DAYS_RANGE, (3, 90));
    }

    /// 旧 history.json 直接可读，缺失的总额度不能补成零。
    #[test]
    fn balance_snapshot_preserves_legacy_records() {
        let legacy = r#"[{"ts":"2026-10-14T09:00:00+08:00","accountId":"a1","balance":18.0,"currency":"USD"}]"#;
        let list: Vec<BalanceSnapshot> = serde_json::from_str(legacy).expect("旧 history 必须可读");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].account_id, "a1");
        assert_eq!(list[0].balance, 18.0);
        assert_eq!(list[0].total, None);

        let back = serde_json::to_string(&list[0]).unwrap();
        assert_eq!(
            back,
            r#"{"ts":"2026-10-14T09:00:00+08:00","accountId":"a1","balance":18.0,"currency":"USD"}"#,
            "旧快照序列化时不应补造 total 字段"
        );
    }

    /// R15：`UsageHistoryFile` 是版本封套；缺字段的文件仍可读（不因单条脏数据报废）
    #[test]
    fn usage_history_file_tolerates_missing_fields() {
        let empty: UsageHistoryFile = serde_json::from_str("{}").expect("{} 应可读");
        assert_eq!(empty.version, USAGE_HISTORY_VERSION);
        assert!(empty.records.is_empty());
        assert_eq!(UsageHistoryFile::default().version, 1);

        let partial: UsageHistoryFile =
            serde_json::from_str(r#"{"records":[{"accountId":"a1","date":"2026-12-31"}]}"#)
                .expect("部分字段应可读");
        assert_eq!(partial.version, 1, "缺 version 时取当前版本");
        assert_eq!(partial.records.len(), 1);
        assert_eq!(partial.records[0].cost, None);
        assert_eq!(partial.records[0].currency, "");
        assert_eq!(partial.records[0].used_total, None);
        assert_eq!(partial.records[0].source, "");
        assert!(!partial.records[0].is_site());
    }

    /// R15 §1.1：`UsageRecord` 的 camelCase 往返（含 source/usedTotal/tokens），
    /// 本地日期与 credits 币种一律原样保存（Rust 不做时区换算、不做币种换算）
    #[test]
    fn usage_record_round_trip_camel_case() {
        let rec = UsageRecord {
            account_id: "acc-1".into(),
            date: "2026-12-31".into(),
            cost: Some(7.5),
            currency: "CREDITS".into(),
            requests: Some(12),
            input_tokens: Some(100.0),
            output_tokens: Some(20.0),
            tokens: Some(120.0),
            used_total: Some(999.0),
            source: "local".into(),
            updated_at: "2026-12-31T23:59:59+08:00".into(),
        };
        let json = serde_json::to_string(&rec).unwrap();
        for key in [
            "\"accountId\"",
            "\"date\"",
            "\"cost\"",
            "\"currency\"",
            "\"requests\"",
            "\"inputTokens\"",
            "\"outputTokens\"",
            "\"tokens\"",
            "\"usedTotal\"",
            "\"source\"",
            "\"updatedAt\"",
        ] {
            assert!(json.contains(key), "缺少 camelCase 键 {key}: {json}");
        }
        assert!(!json.contains("account_id"), "不得出现 snake_case: {json}");

        let back: UsageRecord = serde_json::from_str(&json).unwrap();
        assert_eq!(back, rec);
        assert_eq!(back.date, "2026-12-31", "本地日期原样保存");
        assert_eq!(back.currency, "CREDITS", "credits 原值保留");
        assert!(!back.is_site());
        assert!(UsageRecord {
            source: USAGE_SOURCE_SITE.into(),
            ..rec
        }
        .is_site());
    }

    /// R16 §1 / AC-1：旧配置（无 R16 三字段）加载后为 None（= 默认 false/true/1）
    #[test]
    fn r16_legacy_settings_without_new_fields_are_none() {
        let s: Settings = serde_json::from_str(r#"{"autoRefreshSec":0,"refreshOnStart":true}"#)
            .expect("旧配置应可加载");
        assert_eq!(s.system_notifications, None);
        assert_eq!(s.refresh_retry_enabled, None);
        assert_eq!(s.refresh_retry_max, None);
        assert_eq!(Settings::default().system_notifications, None);
        assert!(validate_settings(&s).is_ok());
    }

    /// R16 §1 / AC-1：三字段 camelCase 往返，不得出现 snake_case
    #[test]
    fn r16_settings_fields_round_trip_camel_case() {
        let json = r#"{
            "systemNotifications": true,
            "refreshRetryEnabled": false,
            "refreshRetryMax": 3
        }"#;
        let s: Settings = serde_json::from_str(json).expect("R16 字段应可反序列化");
        assert_eq!(s.system_notifications, Some(true));
        assert_eq!(s.refresh_retry_enabled, Some(false));
        assert_eq!(s.refresh_retry_max, Some(3));

        let back = serde_json::to_string(&s).unwrap();
        assert!(
            back.contains("\"systemNotifications\":true"),
            "实际: {back}"
        );
        assert!(back.contains("\"refreshRetryEnabled\":false"));
        assert!(back.contains("\"refreshRetryMax\":3"));
        assert!(!back.contains("refresh_retry_max"), "不得出现 snake_case");

        let again: Settings = serde_json::from_str(&back).unwrap();
        assert_eq!(again.refresh_retry_max, Some(3));
    }

    /// R16 §1 / AC-2：`refreshRetryMax` 边界 0 与 3 通过，None 也通过
    #[test]
    fn validate_settings_accepts_retry_max_boundaries() {
        for v in [0u32, 1, 3] {
            let s = Settings {
                refresh_retry_max: Some(v),
                ..Default::default()
            };
            assert!(
                validate_settings(&s).is_ok(),
                "refreshRetryMax={v} 应被接受"
            );
        }
        assert!(validate_settings(&Settings::default()).is_ok());
    }

    /// R16 §1 / AC-2：`refreshRetryMax` 越界（4）被拒且错误可读中文并点出范围
    #[test]
    fn validate_settings_rejects_retry_max_out_of_range() {
        for v in [4u32, 10, 1000] {
            let s = Settings {
                refresh_retry_max: Some(v),
                ..Default::default()
            };
            let err = validate_settings(&s).expect_err("越界必须被拒");
            assert!(err.contains("刷新重试次数"), "错误应点出字段: {err}");
            assert!(err.contains("0–3"), "错误应给出范围: {err}");
        }
    }

    /// R16 §1：重试次数范围常量与规格一致
    #[test]
    fn r16_retry_max_range_matches_spec() {
        assert_eq!(REFRESH_RETRY_MAX_RANGE, (0, 3));
    }
}

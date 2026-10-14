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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_refresh_sec: 0,
            refresh_on_start: true,
            proxy: None,
        }
    }
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

/// 余额历史快照（跨刷新记录，用于余额趋势图）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceSnapshot {
    /// 刷新时间（ISO8601）
    pub ts: String,
    pub account_id: String,
    pub balance: f64,
    pub currency: String,
}

pub fn now_iso() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

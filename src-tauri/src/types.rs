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
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            auto_refresh_sec: 0,
            refresh_on_start: true,
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshOutcome {
    pub account_id: String,
    pub ok: bool,
    pub info: Option<AccountInfo>,
    pub error: Option<String>,
}

pub fn now_iso() -> String {
    chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

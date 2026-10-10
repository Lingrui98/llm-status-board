//! 真实网络集成测试：无需任何凭证，验证 HTTP 栈、错误提取与各官方/中转站真实端点的可达性。
//! 运行：cargo test -- --ignored（需要联网）

use crate::http;
use crate::providers;
use crate::types::AccountConfig;

const MODEL_SERVER_API: &str = "https://codeapi.cs.ac.cn";

#[tokio::test]
#[ignore = "访问真实公网端点"]
async fn modelserver_public_auth_config_ok() {
    let client = http::make_client();
    let v = http::send_json(
        &client,
        "GET",
        &format!("{MODEL_SERVER_API}/api/v1/auth/config"),
        &[],
        None,
    )
    .await
    .expect("auth/config 应可公开访问");
    assert!(
        v.get("oauth_providers").is_some(),
        "响应应包含 oauth_providers: {v}"
    );
}

#[tokio::test]
#[ignore = "访问真实公网端点"]
async fn modelserver_unauthorized_gives_clean_error() {
    let client = http::make_client();
    let err = http::send_json(
        &client,
        "GET",
        &format!("{MODEL_SERVER_API}/api/v1/me"),
        &[],
        None,
    )
    .await
    .expect_err("无 token 访问 /me 应失败");
    // 错误体形如 {"error":{"code":"unauthorized","message":"..."}}，应提取出可读信息
    assert!(!err.trim().is_empty(), "错误信息不应为空");
    assert!(
        err.to_lowercase().contains("unauthorized") || err.to_lowercase().contains("authorization"),
        "应提取出鉴权相关错误，实际: {err}"
    );
}

#[tokio::test]
#[ignore = "访问真实公网端点"]
async fn modelserver_invalid_refresh_token_clean_error() {
    let client = http::make_client();
    let acc = AccountConfig {
        base_url: MODEL_SERVER_API.into(),
        refresh_token: "invalid-token-for-test".into(),
        ..Default::default()
    };
    let err = providers::fetch_account(&client, &acc)
        .await
        .expect_err("无效 refresh_token 应失败");
    assert!(!err.trim().is_empty(), "错误信息不应为空: {err}");
}

#[tokio::test]
#[ignore = "访问真实公网端点"]
async fn deepseek_bad_key_gives_clean_error() {
    let client = http::make_client();
    let err = http::send_json(
        &client,
        "GET",
        "https://api.deepseek.com/user/balance",
        &[("Authorization", "Bearer sk-invalid-invalid-invalid".into())],
        None,
    )
    .await
    .expect_err("无效 key 应失败");
    assert!(!err.trim().is_empty(), "错误信息不应为空");
}

#[tokio::test]
#[ignore = "访问真实公网端点"]
async fn deepseek_provider_bad_key_full_path() {
    let client = http::make_client();
    let acc = AccountConfig {
        kind: crate::types::ProviderKind::DeepSeek,
        base_url: "https://api.deepseek.com".into(),
        api_key: "sk-invalid-invalid-invalid".into(),
        ..Default::default()
    };
    let err = providers::fetch_account(&client, &acc)
        .await
        .expect_err("无效 key 应失败");
    assert!(!err.trim().is_empty());
    println!("deepseek 错误信息（应可读）: {err}");
}

#[tokio::test]
#[ignore = "访问真实公网端点"]
async fn siliconflow_bad_key_not_treated_as_success() {
    let client = http::make_client();
    let acc = AccountConfig {
        kind: crate::types::ProviderKind::SiliconFlow,
        base_url: "https://api.siliconflow.cn".into(),
        api_key: "sk-invalid".into(),
        ..Default::default()
    };
    let result = providers::fetch_account(&client, &acc).await;
    match result {
        Ok(info) => {
            // 如果 HTTP 层放行（200 + code!=20000），适配器必须报错而不是给出假数据
            panic!("无效 key 不应查询成功: {info:?}");
        }
        Err(e) => {
            assert!(!e.trim().is_empty());
            println!("siliconflow 错误信息（应可读）: {e}");
        }
    }
}

#[tokio::test]
#[ignore = "访问真实公网端点"]
async fn moonshot_bad_key_gives_clean_error() {
    let client = http::make_client();
    let acc = AccountConfig {
        kind: crate::types::ProviderKind::Moonshot,
        base_url: "https://api.moonshot.cn".into(),
        api_key: "sk-invalid-invalid-invalid".into(),
        ..Default::default()
    };
    let err = providers::fetch_account(&client, &acc)
        .await
        .expect_err("无效 key 应失败");
    assert!(!err.trim().is_empty());
    println!("moonshot 错误信息（应可读）: {err}");
}

#[test]
fn missing_credentials_give_friendly_errors_without_network() {
    // 各类型在缺凭证时应返回友好错误，而不是 panic 或空错误
    let client = http::make_client();
    let cases = [
        crate::types::ProviderKind::OneApi,
        crate::types::ProviderKind::Sub2Api,
        crate::types::ProviderKind::ModelServer,
        crate::types::ProviderKind::DeepSeek,
    ];
    let rt = tokio::runtime::Runtime::new().unwrap();
    for kind in cases {
        let acc = AccountConfig {
            kind,
            ..Default::default()
        };
        let err = rt
            .block_on(providers::fetch_account(&client, &acc))
            .expect_err("缺凭证应报错");
        assert!(!err.trim().is_empty(), "{kind:?} 缺凭证错误不应为空");
    }
}

/// 示例配置文件必须能被 AppConfig 正确反序列化（camelCase 字段名与结构对齐）
#[test]
fn example_config_parses_as_app_config() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("config.example.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("读取 {} 失败: {e}", path.display()));
    let cfg: crate::types::AppConfig = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("config.example.json 无法反序列化为 AppConfig: {e}"));
    assert_eq!(cfg.version, 1);
    assert_eq!(cfg.accounts.len(), 3, "示例应包含 3 个账号");
    assert!(cfg.settings.refresh_on_start);
    // 逐账号验证关键字段
    let sub2 = cfg
        .accounts
        .iter()
        .find(|a| a.id == "示例-中转站-sub2api")
        .unwrap();
    assert_eq!(sub2.kind, crate::types::ProviderKind::Sub2Api);
    assert!(!sub2.api_key.is_empty());
    let newapi = cfg
        .accounts
        .iter()
        .find(|a| a.id == "示例-中转站-new-api")
        .unwrap();
    assert_eq!(newapi.kind, crate::types::ProviderKind::NewApi);
    assert_eq!(newapi.user_id, Some(1234));
    assert_eq!(newapi.quota_per_unit, Some(500_000.0));
    let ds = cfg
        .accounts
        .iter()
        .find(|a| a.id == "示例-官方-deepseek")
        .unwrap();
    assert_eq!(ds.kind, crate::types::ProviderKind::DeepSeek);
    assert!(ds.base_url.contains("deepseek"));
    // AppConfig 应能无损序列化回 JSON（前端保存路径同样走这个结构）
    let back = serde_json::to_string(&cfg).expect("序列化 AppConfig 失败");
    assert!(back.contains("\"baseUrl\""));
}

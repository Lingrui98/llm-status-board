use super::*;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

fn now() -> DateTime<Utc> {
    DateTime::from_timestamp(2_000_000_000, 0).unwrap()
}
fn payload() -> Value {
    json!({"plan_type":"plus","rate_limit":{"allowed":true,"primary_window":{
        "used_percent":25,"limit_window_seconds":18000,"reset_at":2000003600
    },"secondary_window":{"used_percent":60,"limit_window_seconds":604800,"reset_after_seconds":7200}},
        "credits":{"has_credits":true,"unlimited":false,"balance":"12.50"}})
}

#[test]
fn parses_subscription_windows_without_turning_quota_or_credits_into_money() {
    let info = parse_usage(payload(), now()).unwrap();
    assert_eq!(info.quota_windows.len(), 2);
    assert_eq!(
        info.quota_windows[0].window.as_deref(),
        Some("Codex · 5小时")
    );
    assert_eq!(info.quota_windows[0].used_percent, Some(25.0));
    assert_eq!(
        info.quota_windows[1].window.as_deref(),
        Some("Codex · 每周")
    );
    assert_eq!(info.quota_windows[1].used_percent, Some(60.0));
    assert_eq!(
        info.quota_windows[1].resets_at.as_deref(),
        Some("2033-05-18T05:33:20+00:00")
    );
    assert!(info.balance.is_none() && info.used.is_none() && info.total.is_none());
    assert!(info.daily_usage.is_empty() && info.model_usage.is_empty());
    assert!(info
        .extras
        .iter()
        .any(|e| e.key == "额外 Credits" && e.value == "12.50"));
}

#[test]
fn includes_review_and_model_specific_windows_and_does_not_infer_allowed_from_percent() {
    let mut value = payload();
    value["rate_limit"]["allowed"] = json!(false);
    value["code_review_rate_limit"] =
        json!({"primary_window":{"used_percent":0,"limit_window_seconds":604800}});
    value["additional_rate_limits"] = json!([{"limit_name":"Model quota","rate_limit":{"primary_window":{"used_percent":105,"limit_window_seconds":3600}}}]);
    let info = parse_usage(value, now()).unwrap();
    assert_eq!(info.quota_windows.len(), 4);
    assert_eq!(
        info.quota_windows[2].window.as_deref(),
        Some("代码审查 · 每周")
    );
    assert_eq!(info.quota_windows[3].used_percent, Some(105.0));
    assert!(info.extras.iter().any(|e| e.value == "当前受限"));
}

#[test]
fn pro_with_only_weekly_quota_never_invents_a_five_hour_window() {
    // The server can put a weekly-only allowance in either slot. Slot names do
    // not imply duration, and a missing primary window is not a 0%-used window.
    for field in ["primary_window", "secondary_window"] {
        let mut value = json!({"plan_type":"pro","rate_limit":{
            "allowed":true,"primary_window":null,"secondary_window":null
        }});
        value["rate_limit"][field] = json!({
            "used_percent":60,"limit_window_seconds":604800,"reset_at":2000003600
        });
        let info = parse_usage(value, now()).unwrap();
        assert_eq!(info.quota_windows.len(), 1);
        assert_eq!(
            info.quota_windows[0].window.as_deref(),
            Some("Codex · 每周")
        );
        assert_eq!(info.quota_windows[0].used_percent, Some(60.0));
        assert_eq!(
            info.quota_windows[0].history_key.as_deref(),
            Some("codex:604800")
        );
    }
}

#[test]
fn subscription_scope_survives_token_rotation_and_separates_workspaces() {
    let jwt = |workspace: &str, expiry: i64| {
        format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(
                json!({
                    "exp":expiry,"https://api.openai.com/auth":{"chatgpt_account_id":workspace}
                })
                .to_string()
            )
        )
    };
    let a = validate_credentials(&jwt("workspace-a", 100), None).unwrap();
    let renewed = validate_credentials(&jwt("workspace-a", 200), None).unwrap();
    let b = validate_credentials(&jwt("workspace-b", 200), None).unwrap();
    assert_eq!(subscription_scope(&a), subscription_scope(&renewed));
    assert_ne!(subscription_scope(&a), subscription_scope(&b));
    assert!(!subscription_scope(&a).unwrap().contains("workspace-a"));
    let override_account =
        validate_credentials(&jwt("workspace-a", 200), Some("workspace-b")).unwrap();
    assert_eq!(
        subscription_scope(&b),
        subscription_scope(&override_account)
    );
    assert!(subscription_scope(&validate_credentials("opaque-token", None).unwrap()).is_none());
}

#[test]
fn missing_windows_are_unknown_not_zero_usage_or_unlimited_subscription() {
    let info = parse_usage(
        json!({"plan_type":"pro","rate_limit":null,"credits":{"unlimited":true}}),
        now(),
    )
    .unwrap();
    assert!(info.quota_windows.is_empty());
    assert!(info.note.unwrap().contains("未返回"));
    assert!(info
        .extras
        .iter()
        .any(|e| e.key == "额外 Credits" && e.value == "不限额"));
    assert!(parse_usage(json!({"error":"not authenticated"}), now()).is_err());
}

#[test]
fn malformed_usage_and_reset_fields_fail_instead_of_reporting_zero() {
    for invalid in [json!(null), json!("25"), json!(-1), json!(true)] {
        let mut value = payload();
        value["rate_limit"]["primary_window"]["used_percent"] = invalid;
        assert!(parse_usage(value, now()).is_err());
    }
    let mut value = payload();
    value["rate_limit"]["primary_window"]["reset_at"] = json!(i64::MAX);
    assert!(parse_usage(value, now()).is_err());
    let mut value = payload();
    value["rate_limit"]["secondary_window"]["reset_after_seconds"] = json!(-1);
    assert!(parse_usage(value, now()).is_err());
}

#[test]
fn credential_file_is_read_fresh_and_api_keys_are_rejected() {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/test-tmp")
        .join(format!(
            "codex-auth-{}-{}.json",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let account = AccountConfig {
        codex_auth_path: Some(path.to_string_lossy().into()),
        token: "stale-manual-token".into(),
        ..Default::default()
    };
    for (token, id) in [
        ("first-access-token", "workspace-one"),
        ("new-access-token", "workspace-two"),
    ] {
        std::fs::write(
            &path,
            json!({"tokens":{"access_token":token,"account_id":id,"refresh_token":"not-used"}})
                .to_string(),
        )
        .unwrap();
        let auth = credentials(&account).unwrap();
        assert_eq!(auth.token, token);
        assert_eq!(auth.account_id.as_deref(), Some(id));
    }
    std::fs::write(&path, "not-json-private-content").unwrap();
    assert!(!credentials(&account)
        .err()
        .unwrap()
        .contains("private-content"));
    std::fs::write(&path, json!({"OPENAI_API_KEY":"sk-private"}).to_string()).unwrap();
    assert!(credentials(&account).is_err());
    std::fs::write(
        &path,
        json!({"auth_mode":"apikey","tokens":{"access_token":"stale-login-token"}}).to_string(),
    )
    .unwrap();
    assert!(credentials(&account).is_err());
    std::fs::remove_file(path).unwrap();
    assert!(validate_credentials("sk-api-key", None).is_err());
    assert!(validate_credentials("token\r\nunsafe", None).is_err());
    assert!(validate_credentials("token", Some("account\r\nunsafe")).is_err());
    assert_eq!(
        validate_credentials(" token ", Some(" account "))
            .unwrap()
            .account_id
            .as_deref(),
        Some("account")
    );
}

#[test]
fn only_the_official_subscription_host_is_used_with_real_credentials() {
    for base in [
        "https://chatgpt.com",
        " https://chatgpt.com/backend-api/ ",
        "https://chatgpt.com/backend-api/wham/usage",
    ] {
        assert_eq!(
            usage_url(base).unwrap().as_str(),
            "https://chatgpt.com/backend-api/wham/usage"
        );
    }
    for base in [
        "https://api.openai.com",
        "https://chatgpt.com.evil.test",
        "http://chatgpt.com",
        "https://user:pass@chatgpt.com",
        "https://chatgpt.com?token=secret",
    ] {
        assert!(usage_url(base).is_err());
    }
    let legacy: AccountConfig =
        serde_json::from_value(json!({"kind":"openAi","apiKey":"sk-admin-fixture"})).unwrap();
    assert!(legacy.codex_auth_path.is_none() && legacy.chatgpt_account_id.is_none());
    let account = AccountConfig {
        kind: crate::types::ProviderKind::OpenAiSubscription,
        ..Default::default()
    };
    assert_eq!(
        serde_json::to_value(account).unwrap()["kind"],
        "openAiSubscription"
    );
}

fn server(status: u16, body: String) -> (String, thread::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "http://{}/backend-api/wham/usage",
        listener.local_addr().unwrap()
    );
    listener.set_nonblocking(true).unwrap();
    let task = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    assert!(Instant::now() < deadline);
                    thread::sleep(Duration::from_millis(5));
                }
                Err(e) => panic!("Local fixture failed: {e}"),
            }
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0; 1024];
        while !request.ends_with(b"\r\n\r\n") {
            let count = stream.read(&mut buffer).unwrap();
            assert!(count > 0);
            request.extend_from_slice(&buffer[..count]);
            assert!(request.len() < 16384);
        }
        write!(stream, "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        String::from_utf8(request).unwrap()
    });
    (url, task)
}

#[tokio::test]
async fn sends_only_a_read_only_usage_request_with_chatgpt_authentication() {
    let (url, server) = server(200, payload().to_string());
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let auth = validate_credentials("fixture-access-token", Some("workspace-fixture")).unwrap();
    let info = fetch_usage(&client, &url, &auth).await.unwrap();
    assert_eq!(info.quota_windows.len(), 2);
    let request = server.join().unwrap().to_ascii_lowercase();
    assert!(request.starts_with("get /backend-api/wham/usage http/1.1\r\n"));
    assert!(request.contains("\r\nauthorization: bearer fixture-access-token\r\n"));
    assert!(request.contains("\r\nchatgpt-account-id: workspace-fixture\r\n"));
    assert!(request.contains("\r\naccept: application/json\r\n"));
    assert!(!request.contains("cookie:"));
}

#[tokio::test]
async fn auth_and_server_failures_do_not_expose_tokens_or_return_zero_quota() {
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let auth = validate_credentials("fixture-private-token", None).unwrap();
    for status in [401, 403, 429, 500] {
        let (url, server) = server(status, json!({"error":"fixture-private-token"}).to_string());
        let error = fetch_usage(&client, &url, &auth).await.err().unwrap();
        server.join().unwrap();
        assert!(!error.contains("fixture-private-token"));
        if status == 401 || status == 403 {
            assert!(error.contains("重新登录"));
        }
    }
}

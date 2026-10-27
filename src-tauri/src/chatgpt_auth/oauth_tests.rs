use super::*;
use crate::chatgpt_auth::test_support::{client, jwt, Server};
use serde_json::json;

#[test]
fn authorization_url_has_pkce_and_unpredictable_state_without_a_client_secret() {
    let flow = Flow::new(1455).unwrap();
    let other = Flow::new(1455).unwrap();
    assert_ne!(flow.state, other.state);
    assert_ne!(flow.verifier, other.verifier);
    assert_eq!(flow.verifier.len(), 43);
    let url = reqwest::Url::parse(&flow.auth_url).unwrap();
    assert_eq!(url.host_str(), Some("auth.openai.com"));
    let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(pairs["client_id"], CLIENT_ID);
    assert_eq!(pairs["redirect_uri"], "http://127.0.0.1:1455/auth/callback");
    assert_eq!(pairs["scope"], "openid profile email offline_access");
    assert_eq!(pairs["code_challenge_method"], "S256");
    assert_eq!(
        pairs["code_challenge"],
        URL_SAFE_NO_PAD.encode(Sha256::digest(flow.verifier.as_bytes()))
    );
    assert!(!flow.auth_url.contains(&flow.verifier));
    assert!(!pairs.contains_key("client_secret"));
}

#[test]
fn callback_requires_matching_state_host_method_and_unique_parameters() {
    let flow = Flow::new(1455).unwrap();
    let target = format!("/auth/callback?code=private-code&state={}", flow.state);
    let request =
        |target: &str, host: &str| format!("GET {target} HTTP/1.1\r\nHost: {host}\r\n\r\n");
    assert!(matches!(
        callback(&request(&target, "127.0.0.1:1455"), &flow),
        Callback::Code(_)
    ));
    for invalid in [
        target.replace(&flow.state, "bad"),
        format!("{target}&state={}", flow.state),
        format!("{target}&code=another"),
        format!("{target}&error=denied"),
        target.replace("/auth/callback", "/other"),
        format!("http://127.0.0.1:1455{target}"),
    ] {
        assert!(matches!(
            callback(&request(&invalid, "127.0.0.1:1455"), &flow),
            Callback::Ignore
        ));
    }
    assert!(matches!(
        callback(&request(&target, "evil.example"), &flow),
        Callback::Ignore
    ));
    assert!(matches!(
        callback(
            &request(&target, "127.0.0.1:1455").replacen("GET", "POST", 1),
            &flow
        ),
        Callback::Ignore
    ));
    let denied = format!("/auth/callback?error=access_denied&state={}", flow.state);
    assert!(matches!(
        callback(&request(&denied, "127.0.0.1:1455"), &flow),
        Callback::Denied
    ));
}

#[tokio::test]
async fn browser_callback_exchanges_code_and_does_not_reflect_secrets() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let flow = Flow::new(listener.local_addr().unwrap().port()).unwrap();
    let callback_url = format!(
        "{}?code=fixture-code&state={}",
        flow.redirect_uri, flow.state
    );
    let expected_verifier = flow.verifier.clone();
    let token = jwt(
        json!({"exp":chrono::Utc::now().timestamp()+3600,"https://api.openai.com/auth":{"chatgpt_account_id":"fixture-account"}}),
    );
    let server = Server::json(
        200,
        json!({"access_token":token,"refresh_token":"fixture-refresh"}),
    );
    let endpoint = server.url.clone();
    let task = tokio::spawn(async move { login(listener, flow, &client(), &endpoint).await });
    let bad = callback_url.replace("state=", "state=invalid");
    assert_eq!(client().get(bad).send().await.unwrap().status(), 400);
    let response = client().get(&callback_url).send().await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let page = response.text().await.unwrap();
    for secret in [
        "fixture-code",
        "fixture-refresh",
        token.as_str(),
        expected_verifier.as_str(),
    ] {
        assert!(!page.contains(secret));
    }
    let session = task.await.unwrap().unwrap();
    assert_eq!(session.account_id.as_deref(), Some("fixture-account"));
    let requests = server.finish();
    assert_eq!(requests.len(), 1);
    let body = requests[0].split_once("\r\n\r\n").unwrap().1;
    let url = reqwest::Url::parse(&format!("http://local/?{body}")).unwrap();
    let params: std::collections::HashMap<_, _> = url.query_pairs().collect();
    assert_eq!(params["grant_type"], "authorization_code");
    assert_eq!(params["code_verifier"], expected_verifier);
    assert_eq!(params["code"], "fixture-code");
    assert!(!requests[0].to_lowercase().contains("authorization:"));
}

#[tokio::test]
async fn timeout_releases_listener_and_fallback_does_not_evict_another_process() {
    let occupied = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let busy_port = occupied.local_addr().unwrap().port();
    let fallback = bind_ports(&[busy_port, 0]).await.unwrap();
    let address = fallback.local_addr().unwrap();
    assert_ne!(address.port(), busy_port);
    let flow = Flow::new(address.port()).unwrap();
    assert!(tokio::time::timeout(
        Duration::from_millis(25),
        login(fallback, flow, &client(), TOKEN_URL)
    )
    .await
    .is_err());
    assert!(TcpListener::bind(address).await.is_ok());
    assert!(bind_ports(&[busy_port]).await.is_err());
}

#[test]
fn refresh_preserves_omitted_rotation_and_rejects_account_switch_and_expired_token() {
    let previous = Session {
        access_token: "old".into(),
        refresh_token: "keep".into(),
        account_id: Some("a".into()),
        expires_at: 100,
    };
    let value = json!({"access_token":"new", "expires_in":3600});
    let updated = parse_session(&value, Some(&previous), 1000).unwrap();
    assert_eq!(updated.refresh_token, "keep");
    assert_eq!(updated.account_id.as_deref(), Some("a"));
    assert_eq!(updated.expires_at, 4600);
    let wrong = jwt(json!({"exp":5000,"https://api.openai.com/auth":{"chatgpt_account_id":"b"}}));
    assert!(parse_session(&json!({"access_token":wrong}), Some(&previous), 1000).is_err());
    assert!(parse_session(
        &json!({"access_token":jwt(json!({"exp":10})),"refresh_token":"r"}),
        None,
        1000
    )
    .is_err());
    assert!(parse_session(&json!({"access_token":"new"}), None, 1000).is_err());
    assert!(parse_session(
        &json!({"access_token":"sk-api-key","refresh_token":"r"}),
        None,
        1000
    )
    .is_err());
}

#[tokio::test]
async fn rejected_or_redirected_token_requests_hide_body_secrets() {
    for status in [400, 401, 403, 429, 500] {
        let server = Server::json(
            status,
            json!({"error_description":"private-code private-refresh"}),
        );
        let error = exchange(&client(), &server.url, &[("code", "private-code")], None)
            .await
            .err()
            .unwrap();
        assert!(!error.contains("private-code") && !error.contains("private-refresh"));
        server.finish();
    }
    let server = Server::new(vec!["HTTP/1.1 307 Redirect\r\nLocation: https://example.invalid/token\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into()]);
    let error = exchange(&client(), &server.url, &[("code", "private-code")], None)
        .await
        .err()
        .unwrap();
    assert!(error.contains("307"));
    assert_eq!(server.finish().len(), 1);
}

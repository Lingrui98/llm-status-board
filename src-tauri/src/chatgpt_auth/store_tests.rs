use super::*;
use crate::chatgpt_auth::test_support::{client, Server};
use serde_json::json;

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!(
            "llm-board-oauth-test-{}",
            oauth::random_id().unwrap()
        )))
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn session(expired: bool) -> Session {
    Session {
        access_token: "fixture-old-access".into(),
        refresh_token: "fixture-old-refresh".into(),
        account_id: Some("fixture-account".into()),
        expires_at: chrono::Utc::now().timestamp() + if expired { -100 } else { 3600 },
    }
}

#[tokio::test]
async fn restart_keeps_credentials_out_of_config_and_forget_removes_them() {
    let dir = Directory::new();
    let store = Store::new(dir.0.clone());
    let reference = store.save_new(session(false)).await.unwrap();
    let account = crate::types::AccountConfig {
        chatgpt_auth_id: Some(reference.auth_id.clone()),
        ..Default::default()
    };
    let exported = serde_json::to_string(&account).unwrap();
    assert!(exported.contains(&reference.auth_id));
    assert!(!exported.contains("fixture-old-access") && !exported.contains("fixture-old-refresh"));
    let restarted = Store::new(dir.0.clone());
    let credentials = restarted
        .credentials(&client(), oauth::TOKEN_URL, &reference.auth_id, None)
        .await
        .unwrap();
    assert_eq!(credentials.token, "fixture-old-access");
    assert_eq!(credentials.account_id.as_deref(), Some("fixture-account"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&dir.0).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(store.path(&reference.auth_id).unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    restarted.forget(&reference.auth_id).await.unwrap();
    assert!(!store.path(&reference.auth_id).unwrap().exists());
    assert!(restarted
        .credentials(&client(), oauth::TOKEN_URL, &reference.auth_id, None)
        .await
        .err()
        .unwrap()
        .contains("找不到此设备的 ChatGPT 登录"));
}

#[tokio::test]
async fn concurrent_queries_rotate_once_and_persist_before_next_usage() {
    let dir = Directory::new();
    let store = Store::new(dir.0.clone());
    let reference = store.save_new(session(true)).await.unwrap();
    let server = Server::json(
        200,
        json!({"access_token":"fixture-new-access","refresh_token":"fixture-new-refresh","expires_in":3600}),
    );
    let client = client();
    let (a, b) = tokio::join!(
        store.credentials(&client, &server.url, &reference.auth_id, None),
        store.credentials(&client, &server.url, &reference.auth_id, None)
    );
    assert_eq!(a.unwrap().token, "fixture-new-access");
    assert_eq!(b.unwrap().token, "fixture-new-access");
    let saved: Session =
        serde_json::from_slice(&fs::read(store.path(&reference.auth_id).unwrap()).unwrap())
            .unwrap();
    assert_eq!(saved.refresh_token, "fixture-new-refresh");
    let requests = server.finish();
    assert_eq!(requests.len(), 1);
    assert!(requests[0].contains("grant_type=refresh_token"));
    assert!(requests[0].contains("refresh_token=fixture-old-refresh"));
}

#[tokio::test]
async fn concurrent_unauthorized_recovery_does_not_refresh_an_already_replaced_token() {
    let dir = Directory::new();
    let store = Store::new(dir.0.clone());
    let reference = store.save_new(session(false)).await.unwrap();
    let server = Server::json(
        200,
        json!({"access_token":"updated","refresh_token":"rotated","expires_in":3600}),
    );
    let client = client();
    let (a, b) = tokio::join!(
        store.credentials(
            &client,
            &server.url,
            &reference.auth_id,
            Some("fixture-old-access")
        ),
        store.credentials(
            &client,
            &server.url,
            &reference.auth_id,
            Some("fixture-old-access")
        )
    );
    assert_eq!(a.unwrap().token, "updated");
    assert_eq!(b.unwrap().token, "updated");
    assert_eq!(server.finish().len(), 1);
}

#[tokio::test]
async fn failed_rotation_write_retains_new_tokens_and_retries_persistence_without_reusing_old_refresh(
) {
    let dir = Directory::new();
    let store = Store::new(dir.0.clone());
    let reference = store.save_new(session(true)).await.unwrap();
    let path = store.path(&reference.auth_id).unwrap();
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap(); // Force rename failure on all platforms, including root.
    let server = Server::json(
        200,
        json!({"access_token":"rotated-access","refresh_token":"rotated-refresh","expires_in":3600}),
    );
    let error = store
        .credentials(&client(), &server.url, &reference.auth_id, None)
        .await
        .err()
        .unwrap();
    assert!(error.contains("保存 ChatGPT 凭据失败"));
    fs::remove_dir(&path).unwrap();
    let recovered = store
        .credentials(&client(), &server.url, &reference.auth_id, None)
        .await
        .unwrap();
    assert_eq!(recovered.token, "rotated-access");
    let restarted = Store::new(dir.0.clone());
    let after_restart = restarted
        .credentials(&client(), &server.url, &reference.auth_id, None)
        .await
        .unwrap();
    assert_eq!(after_restart.token, "rotated-access");
    assert_eq!(server.finish().len(), 1);
    let persisted: Session = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(persisted.refresh_token, "rotated-refresh");
}

#[tokio::test]
async fn rejected_refresh_keeps_previous_session_and_hides_server_body() {
    let dir = Directory::new();
    let store = Store::new(dir.0.clone());
    let reference = store.save_new(session(true)).await.unwrap();
    let server = Server::json(401, json!({"error":"fixture-old-refresh private-response"}));
    let error = store
        .credentials(&client(), &server.url, &reference.auth_id, None)
        .await
        .err()
        .unwrap();
    assert!(error.contains("重新"));
    assert!(!error.contains("fixture-old-refresh") && !error.contains("private-response"));
    let persisted: Session =
        serde_json::from_slice(&fs::read(store.path(&reference.auth_id).unwrap()).unwrap())
            .unwrap();
    assert_eq!(persisted.refresh_token, "fixture-old-refresh");
    server.finish();
}

#[tokio::test]
async fn invalid_reference_cannot_read_or_delete_arbitrary_paths() {
    let dir = Directory::new();
    let store = Store::new(dir.0.clone());
    for id in ["../auth", "../../config.json", "", "auth.json"] {
        assert!(store
            .credentials(&client(), oauth::TOKEN_URL, id, None)
            .await
            .is_err());
        assert!(store.forget(id).await.is_err());
    }
    assert!(!dir.0.exists());
}

//! AiHubMix API Key 计费查询。总额度为美元，累计用量为美分；不附加日期筛选。

use crate::http;
use crate::types::{AccountConfig, AccountInfo, Money};
use serde_json::{json, Value};

pub async fn fetch(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let key = acc.api_key.trim();
    if key.is_empty() {
        return Err("需要填写 AiHubMix API Key".into());
    }
    let base = acc.base();
    let (header, value) = http::bearer(key);
    let headers = [
        (header.as_str(), value),
        ("Accept", "application/json".to_string()),
    ];
    let subscription = http::send_json(
        client,
        "GET",
        &format!("{base}/dashboard/billing/subscription"),
        &headers,
        None,
    )
    .await
    .map_err(|e| format!("AiHubMix 查询总额度失败: {e}"))?;
    let usage = http::send_json(
        client,
        "GET",
        &format!("{base}/dashboard/billing/usage"),
        &headers,
        None,
    )
    .await
    .map_err(|e| format!("AiHubMix 查询用量失败: {e}"))?;

    parse_billing(subscription, usage)
}

fn billing_amount(response: &Value, field: &str) -> Result<f64, String> {
    let amount = match response.get(field) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    amount
        .filter(|n| n.is_finite() && *n >= 0.0)
        .ok_or_else(|| format!("AiHubMix 响应缺少有效的 {field}（应为非负有限数值）"))
}

fn parse_billing(subscription: Value, usage: Value) -> Result<AccountInfo, String> {
    let total = billing_amount(&subscription, "hard_limit_usd")?;
    let used = billing_amount(&usage, "total_usage")? / 100.0;
    let usd = |amount| Money {
        amount,
        currency: "USD".into(),
    };
    Ok(AccountInfo {
        balance: Some(usd(total - used)),
        used: Some(usd(used)),
        total: Some(usd(total)),
        note: Some("AiHubMix 总额度与累计用量（USD）".into()),
        raw: Some(json!({ "subscription": subscription, "usage": usage })),
        fetched_at: crate::types::now_iso(),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ProviderKind;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn converts_cents_before_calculating_balance() {
        let subscription = json!({ "hard_limit_usd": 29520.97954 });
        let usage = json!({ "total_usage": 2937045.8762 });
        let info = parse_billing(subscription.clone(), usage.clone()).unwrap();
        let balance = info.balance.unwrap();
        let used = info.used.unwrap();
        let total = info.total.unwrap();
        assert!((balance.amount - 150.520778).abs() < 1e-8);
        assert!((used.amount - 29370.458762).abs() < 1e-8);
        assert_eq!(total.amount, 29520.97954);
        for money in [balance, used, total] {
            assert_eq!(money.currency, "USD");
        }
        assert_eq!(
            info.raw.unwrap(),
            json!({ "subscription": subscription, "usage": usage })
        );
        assert!(!info.fetched_at.is_empty());
        assert!(info.daily_usage.is_empty());
        assert!(info.model_usage.is_empty());
    }

    #[test]
    fn accepts_numeric_strings_zero_and_overdrawn_balances() {
        for (total, cents, expected) in
            [(" 10.50 ", "250", 8.0), ("0", "0", 0.0), ("1", "150", -0.5)]
        {
            let info = parse_billing(
                json!({ "hard_limit_usd": total }),
                json!({ "total_usage": cents }),
            )
            .unwrap();
            assert_eq!(info.balance.unwrap().amount, expected);
        }
    }

    #[test]
    fn rejects_missing_malformed_negative_and_non_finite_amounts() {
        let valid_subscription = json!({ "hard_limit_usd": 10 });
        let valid_usage = json!({ "total_usage": 100 });
        for bad in [
            Value::Null,
            json!(true),
            json!([]),
            json!({}),
            json!(""),
            json!("not a number"),
            json!("NaN"),
            json!("inf"),
            json!("1e999"),
            json!(-1),
            json!("-1"),
        ] {
            let err =
                parse_billing(json!({ "hard_limit_usd": bad }), valid_usage.clone()).unwrap_err();
            assert!(err.contains("hard_limit_usd"), "{err}");
            let err = parse_billing(valid_subscription.clone(), json!({ "total_usage": bad }))
                .unwrap_err();
            assert!(err.contains("total_usage"), "{err}");
        }
        assert!(parse_billing(json!({}), valid_usage)
            .unwrap_err()
            .contains("hard_limit_usd"));
        assert!(
            parse_billing(valid_subscription, json!({ "error": "invalid key" }))
                .unwrap_err()
                .contains("total_usage")
        );
    }

    #[test]
    fn provider_kind_round_trips_in_account_configuration() {
        let acc = AccountConfig {
            kind: ProviderKind::AiHubMix,
            ..Default::default()
        };
        let saved = serde_json::to_value(&acc).unwrap();
        assert_eq!(saved["kind"], "aiHubMix");
        let restored: AccountConfig = serde_json::from_value(saved).unwrap();
        assert_eq!(restored.kind, ProviderKind::AiHubMix);
    }

    // A local HTTP fixture checks real request paths, headers, status handling,
    // and dispatch without provider credentials or external network access.
    fn billing_server(
        subscription_status: u16,
        usage_status: u16,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            let expected = if subscription_status == 200 { 2 } else { 1 };
            let deadline = Instant::now() + Duration::from_secs(5);
            while requests.len() < expected {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "Billing requests did not arrive");
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("Local billing server failed: {e}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.ends_with(b"\r\n\r\n") {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0, "Incomplete billing request");
                    request.extend_from_slice(&buffer[..count]);
                    assert!(request.len() < 16384);
                }
                let request = String::from_utf8(request).unwrap();
                let (status, body) = match request.lines().next().unwrap() {
                    "GET /dashboard/billing/subscription HTTP/1.1" => (
                        subscription_status,
                        json!({ "hard_limit_usd": 29520.97954 }),
                    ),
                    "GET /dashboard/billing/usage HTTP/1.1" => {
                        (usage_status, json!({ "total_usage": 2937045.8762 }))
                    }
                    other => panic!("Unexpected billing request: {other}"),
                };
                let body = if status == 200 {
                    body.to_string()
                } else {
                    json!({ "error": { "message": "billing request rejected" } }).to_string()
                };
                write!(stream, "HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
                requests.push(request);
            }
            requests
        });
        (base, handle)
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    #[tokio::test]
    async fn dispatches_both_billing_requests_with_bearer_key_and_no_date_filter() {
        let (base, server) = billing_server(200, 200);
        let acc = AccountConfig {
            kind: ProviderKind::AiHubMix,
            base_url: format!(" {base}/ "),
            api_key: " test-aihubmix-key ".into(),
            ..Default::default()
        };
        let info = crate::providers::fetch_account(&client(), &acc)
            .await
            .unwrap();
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);
        for request in requests {
            assert!(request
                .to_ascii_lowercase()
                .contains("\r\nauthorization: bearer test-aihubmix-key\r\n"));
            assert!(request
                .to_ascii_lowercase()
                .contains("\r\naccept: application/json\r\n"));
        }
        assert!((info.balance.unwrap().amount - 150.520778).abs() < 1e-8);
    }

    #[tokio::test]
    async fn reports_failure_from_either_billing_endpoint() {
        for (subscription_status, usage_status, context) in
            [(401, 200, "查询总额度失败"), (200, 503, "查询用量失败")]
        {
            let (base, server) = billing_server(subscription_status, usage_status);
            let acc = AccountConfig {
                kind: ProviderKind::AiHubMix,
                base_url: base,
                api_key: "test-aihubmix-key".into(),
                ..Default::default()
            };
            let err = fetch(&client(), &acc).await.unwrap_err();
            server.join().unwrap();
            assert!(err.contains(context), "{err}");
            assert!(err.contains("billing request rejected"), "{err}");
        }
    }

    #[tokio::test]
    async fn rejects_blank_api_key_before_making_requests() {
        let acc = AccountConfig {
            kind: ProviderKind::AiHubMix,
            api_key: " \t ".into(),
            ..Default::default()
        };
        assert_eq!(
            fetch(&client(), &acc).await.unwrap_err(),
            "需要填写 AiHubMix API Key"
        );
    }
}

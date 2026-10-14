//! 自定义 HTTP 查询适配器：发一个请求，用点路径从 JSON 响应里提取余额/用量。
//! URL / Header 值 / Body 支持 {key} 占位符（替换为 API Key）。

use crate::http;
use crate::jsonpath::{lookup_number, lookup_string};
use crate::types::{AccountConfig, AccountInfo, CustomQuery, Money};

pub async fn fetch(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let c: &CustomQuery = acc
        .custom
        .as_ref()
        .ok_or("自定义查询缺少配置（请在表单里填写自定义 HTTP 查询）")?;

    let url = c.url.replace("{key}", &acc.api_key);
    if url.trim().is_empty() {
        return Err("自定义查询缺少 URL".into());
    }

    let mut headers: Vec<(String, String)> = Vec::new();
    for h in &c.headers {
        let value = h.value.replace("{key}", &acc.api_key);
        headers.push((h.key.clone(), value));
    }
    let header_refs: Vec<(&str, String)> = headers
        .iter()
        .map(|(k, v)| (k.as_str(), v.clone()))
        .collect();
    let body = c.body.as_ref().map(|b| b.replace("{key}", &acc.api_key));

    let v = http::send_json(client, &c.method, &url, &header_refs, body.as_deref()).await?;

    let scale = c.scale.unwrap_or(1.0);
    let currency = c
        .currency_path
        .as_deref()
        .and_then(|p| lookup_string(&v, p))
        .or_else(|| c.currency.clone())
        .unwrap_or_else(|| "USD".into());

    let num = |path: &Option<String>| -> Option<f64> {
        path.as_deref()
            .and_then(|p| lookup_number(&v, p))
            .map(|n| n * scale)
    };

    let mut extras = Vec::new();
    for kv in &c.extra_paths {
        if let Some(s) = lookup_string(&v, &kv.value) {
            extras.push(crate::types::KeyValue {
                key: kv.key.clone(),
                value: s,
            });
        } else if let Some(n) = lookup_number(&v, &kv.value) {
            extras.push(crate::types::KeyValue {
                key: kv.key.clone(),
                value: format_number(n),
            });
        }
    }

    let m = |n: f64| Money {
        amount: n,
        currency: currency.clone(),
    };

    Ok(AccountInfo {
        balance: num(&c.balance_path).map(m),
        used: num(&c.used_path).map(m),
        total: num(&c.total_path).map(m),
        requests: None,
        note: None,
        extras,
        raw: Some(v),
        fetched_at: crate::types::now_iso(),
        new_token: None,
        new_refresh_token: None,
        ..Default::default()
    })
}

fn format_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

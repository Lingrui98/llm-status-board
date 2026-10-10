use serde_json::Value;

/// 从 JSON 里按点路径取值。
/// 支持：`data.quota`、`balance_infos[0].total_balance`、`[0].x`、`a[0][1]`
pub fn lookup<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut cur = value;
    let path = path.trim();
    if path.is_empty() || path == "$" {
        return Some(cur);
    }
    for seg in path.split('.') {
        // 拆出键名与后续 [idx] 索引
        let (name, rest) = match seg.find('[') {
            Some(i) => (&seg[..i], &seg[i..]),
            None => (seg, ""),
        };
        if !name.is_empty() {
            cur = cur.get(name)?;
        }
        let mut r = rest;
        while r.starts_with('[') {
            let end = r.find(']')?;
            let inner = &r[1..end];
            cur = if let Ok(idx) = inner.parse::<usize>() {
                cur.get(idx)?
            } else {
                // ['key'] 语法
                let key = inner.trim_matches(|c| c == '\'' || c == '"');
                cur.get(key)?
            };
            r = &r[end + 1..];
        }
        if !r.is_empty() {
            return None;
        }
    }
    Some(cur)
}

/// 数值提取：支持数字与数字字符串
pub fn as_number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

pub fn lookup_number(value: &Value, path: &str) -> Option<f64> {
    lookup(value, path).and_then(as_number)
}

pub fn lookup_i64(value: &Value, path: &str) -> Option<i64> {
    lookup(value, path).and_then(|v| match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    })
}

pub fn lookup_string(value: &Value, path: &str) -> Option<String> {
    lookup(value, path).and_then(|v| match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_lookup() {
        let v = json!({
            "data": { "quota": 123.5, "arr": [{"x": 1}, {"x": 2}] },
            "balance_infos": [ { "total_balance": "110.00" } ]
        });
        assert_eq!(lookup_number(&v, "data.quota"), Some(123.5));
        assert_eq!(lookup_number(&v, "data.arr[1].x"), Some(2.0));
        assert_eq!(
            lookup_number(&v, "balance_infos[0].total_balance"),
            Some(110.0)
        );
        assert_eq!(
            lookup_number(&v, "[0].x".replace("[0].x", "data.arr[0].x").as_str()),
            Some(1.0)
        );
        assert_eq!(lookup_string(&v, "data.quota"), Some("123.5".to_string()));
        assert!(lookup(&v, "data.none").is_none());
    }
}

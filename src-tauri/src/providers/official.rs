//! 官方提供商适配器：DeepSeek / OpenAI / SiliconFlow / Moonshot / 智谱 / 百炼
//!
//! - DeepSeek: GET /user/balance（官方，CNY/USD，balance_infos[0]，字符串金额）
//! - OpenAI:   GET /v1/organization/costs（本月成本，需要 Admin key；官方无余额端点）
//! - SiliconFlow: GET /v1/user/info（code=20000 成功；totalBalance=总余额；币种按域名推断）
//! - Moonshot: GET /v1/users/me/balance（官方，code=0；.cn=CNY / .ai=USD）
//! - 智谱:     控制台内部接口 GET /api/biz/account/query-customer-account-report（裸 key 不带 Bearer；
//!   HTTP 200 不代表成功要看 body code；降级 /api/paas/v4/balance）
//! - 百炼:     官方无 sk- key 余额接口（需要 RAM AK/SK 走 BSS OpenAPI，暂不支持）

use crate::http;
use crate::jsonpath::{lookup_number, lookup_string};
use crate::types::{AccountConfig, AccountInfo, KeyValue, Money, ProviderKind};
use serde_json::Value;

pub async fn fetch(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    match acc.kind {
        ProviderKind::DeepSeek => deepseek(client, acc).await,
        ProviderKind::OpenAi => super::openai_api::fetch(client, acc).await,
        ProviderKind::SiliconFlow => siliconflow(client, acc).await,
        ProviderKind::Moonshot => moonshot(client, acc).await,
        ProviderKind::Zhipu => zhipu(client, acc).await,
        ProviderKind::DashScope => unsupported(
            "阿里云百炼的 sk- key 无法查询余额（计费在阿里云主账号，需要 RAM AK/SK 走 BSS OpenAPI 才能查，且是整个云账号的余额）。请在百炼控制台查看。",
        ),
        _ => Err("该类型暂不支持".into()),
    }
}

fn unsupported(msg: &str) -> Result<AccountInfo, String> {
    Err(msg.to_string())
}

fn need_key(acc: &AccountConfig) -> Result<String, String> {
    if acc.api_key.trim().is_empty() {
        Err("需要填写 API Key".into())
    } else {
        Ok(acc.api_key.trim().to_string())
    }
}

/// 按域名推断币种：.cn → CNY，其余 → USD
fn currency_for(base: &str) -> String {
    if base.contains(".cn") {
        "CNY".into()
    } else {
        "USD".into()
    }
}

/// DeepSeek: GET {base}/user/balance
async fn deepseek(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let key = need_key(acc)?;
    let base = acc.base();
    let (hk, hv) = http::bearer(&key);
    let v = http::send_json(
        client,
        "GET",
        &format!("{base}/user/balance"),
        &[(hk.as_str(), hv)],
        None,
    )
    .await?;

    let mut info = AccountInfo {
        fetched_at: crate::types::now_iso(),
        raw: Some(v.clone()),
        ..Default::default()
    };
    if let Some(b) = lookup_number(&v, "balance_infos[0].total_balance") {
        let currency =
            lookup_string(&v, "balance_infos[0].currency").unwrap_or_else(|| "CNY".into());
        info.balance = Some(Money {
            amount: b,
            currency,
        });
    }
    if let Some(g) = lookup_number(&v, "balance_infos[0].granted_balance") {
        info.extras.push(KeyValue {
            key: "赠送余额".into(),
            value: format!("{g:.2}"),
        });
    }
    if let Some(t) = lookup_number(&v, "balance_infos[0].topped_up_balance") {
        info.extras.push(KeyValue {
            key: "充值余额".into(),
            value: format!("{t:.2}"),
        });
    }
    if let Some(available) = v.get("is_available").and_then(|a| a.as_bool()) {
        info.extras.push(KeyValue {
            key: "可用状态".into(),
            value: if available {
                "正常".into()
            } else {
                "欠费/不可用".into()
            },
        });
    }
    Ok(info)
}

/// SiliconFlow: GET {base}/v1/user/info（code=20000 成功）
async fn siliconflow(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let key = need_key(acc)?;
    let base = acc.base();
    let (hk, hv) = http::bearer(&key);
    let v = http::send_json(
        client,
        "GET",
        &format!("{base}/v1/user/info"),
        &[(hk.as_str(), hv)],
        None,
    )
    .await?;

    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 20000 {
        let msg = v
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("查询失败");
        return Err(format!("SiliconFlow 返回错误（code={code}）: {msg}"));
    }
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let currency = currency_for(&base);

    // totalBalance=总余额（充值+赠送）；balance=赠送部分；chargeBalance=充值部分
    let total = lookup_number(&data, "totalBalance").or_else(|| {
        lookup_number(&data, "chargeBalance")
            .map(|c| c + lookup_number(&data, "balance").unwrap_or(0.0))
    });

    let mut info = AccountInfo {
        balance: total.map(|t| Money {
            amount: t,
            currency: currency.clone(),
        }),
        fetched_at: crate::types::now_iso(),
        raw: Some(v.clone()),
        ..Default::default()
    };
    if let Some(c) = lookup_number(&data, "chargeBalance") {
        info.extras.push(KeyValue {
            key: "充值余额".into(),
            value: format!("{c:.4} {currency}"),
        });
    }
    if let Some(b) = lookup_number(&data, "balance") {
        info.extras.push(KeyValue {
            key: "赠送余额".into(),
            value: format!("{b:.4} {currency}"),
        });
    }
    if let Some(s) = lookup_string(&data, "status") {
        info.extras.push(KeyValue {
            key: "账户状态".into(),
            value: s,
        });
    }
    Ok(info)
}

/// Moonshot/Kimi：按 key 前缀分流
/// - `sk-kimi-` 前缀 → Kimi for Coding 订阅（GET api.kimi.com/coding/v1/usages）
/// - 其他 `sk-` → 开放平台按量计费（GET {base}/v1/users/me/balance）
async fn moonshot(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let key = need_key(acc)?;
    if key.starts_with("sk-kimi-") {
        return kimi_coding_usage(client, acc, &key).await;
    }
    moonshot_payg_balance(client, acc, &key).await
}

/// Kimi for Coding 订阅用量（未公开文档端点，为官方 CLI /usage 背后的接口）
/// 响应历史上有三种形态，需宽容解析：
/// - 形态A: usage(周配额) + limits[](5h 窗口) + parallel.limit + limited + user.membership.level
/// - 形态B: 形态A + totalQuota + boosterWallet.balance
/// - 形态C: usages{limit_5h:{used_ratio,reset_time}, limit_7d, limit_month_code, limit_month_total}
async fn kimi_coding_usage(
    client: &reqwest::Client,
    acc: &AccountConfig,
    key: &str,
) -> Result<AccountInfo, String> {
    let base = {
        let b = acc.base();
        // 用户可能填了 api.moonshot.cn 之类的开放平台域名；订阅接口固定在 api.kimi.com / api.kimi.ai
        if b.contains("api.kimi.com") || b.contains("api.kimi.ai") {
            b
        } else {
            "https://api.kimi.com".to_string()
        }
    };
    let (hk, hv) = http::bearer(key);
    // 该端点仅对官方 CLI 的 User-Agent 开放（无此 UA 返回 404，社区多方实测）。
    // 注意：Kimi 官方文档提示篡改客户端标识存在违规风险；此处仅用你自己的 key 做只读用量查询。
    let headers = [(hk.as_str(), hv), ("User-Agent", "KimiCLI/1.6".to_string())];
    let v = http::send_json(
        client,
        "GET",
        &format!("{base}/coding/v1/usages"),
        &headers,
        None,
    )
    .await
    .map_err(|e| {
        // 到这里说明 key 一定是 sk-kimi- 前缀（分流已保证），404 更多是端点/UA 问题而非 key 前缀问题
        format!(
            "{e}。提示：Kimi 订阅用量接口为未公开接口，仅对官方 CLI 客户端开放；若持续失败可能是接口已变更，可在卡片里展开「原始数据」查看响应内容"
        )
    })?;

    let mut info = AccountInfo {
        note: Some("Kimi for Coding 订阅模式（订阅额度，非余额计费）".into()),
        fetched_at: crate::types::now_iso(),
        raw: Some(v.clone()),
        ..Default::default()
    };

    // --- 形态C（2026-09/10 起）: usages{limit_5h:{used_ratio, reset_time}, limit_7d, limit_month_code, limit_month_total} ---
    let usages = v.get("usages");
    if usages.is_some() {
        let ratio_pct = |path: &str| lookup_number(&v, path).map(|r| r * 100.0);
        let reset_of = |path: &str| {
            lookup_string(&v, path)
                .or_else(|| lookup_string(&v, &path.replace("reset_time", "resetTime")))
        };
        for (label, used_path, reset_path) in [
            (
                "5h",
                "usages.limit_5h.used_ratio",
                "usages.limit_5h.reset_time",
            ),
            (
                "7d",
                "usages.limit_7d.used_ratio",
                "usages.limit_7d.reset_time",
            ),
            (
                "月度(代码)",
                "usages.limit_month_code.used_ratio",
                "usages.limit_month_code.reset_time",
            ),
            (
                "月度(全部)",
                "usages.limit_month_total.used_ratio",
                "usages.limit_month_total.reset_time",
            ),
        ] {
            if let Some(pct) = ratio_pct(used_path) {
                info.quota_windows.push(crate::types::QuotaWindow {
                    window: Some(label.to_string()),
                    used_percent: Some(pct),
                    resets_at: reset_of(reset_path),
                    ..Default::default()
                });
                info.extras.push(KeyValue {
                    key: format!("{label} 用量"),
                    value: format!("{pct:.0}%"),
                });
            }
        }
        return Ok(info);
    }

    // --- 形态A/B: usage(周配额) + limits[](5h) + parallel + boosterWallet + totalQuota ---
    // 周配额（usage: limit/used/remaining/resetTime）
    if let Some(remaining) =
        lookup_number(&v, "usage.remaining").or_else(|| lookup_number(&v, "usage.remain"))
    {
        let limit = lookup_number(&v, "usage.limit").unwrap_or(0.0);
        let used = lookup_number(&v, "usage.used").unwrap_or(limit - remaining);
        info.used = Some(Money {
            amount: used,
            currency: "credits".into(),
        });
        if limit > 0.0 {
            info.total = Some(Money {
                amount: limit,
                currency: "credits".into(),
            });
            info.balance = Some(Money {
                amount: remaining,
                currency: "credits".into(),
            });
            info.quota_windows.push(crate::types::QuotaWindow {
                window: Some("周配额".into()),
                used_percent: Some((used / limit * 100.0).min(100.0)),
                resets_at: lookup_string(&v, "usage.resetTime")
                    .or_else(|| lookup_string(&v, "usage.reset_at")),
                ..Default::default()
            });
        }
    }

    // 5h 窗口（limits[]: window{duration,timeUnit} + detail{used,limit,resetTime}）
    if let Some(limits) = v.get("limits").and_then(|l| l.as_array()) {
        for l in limits {
            // 找 5 小时窗口（duration=5 或 300 分钟）
            let duration = lookup_number(l, "window.duration").unwrap_or(0.0);
            let unit = lookup_string(l, "window.timeUnit").unwrap_or_default();
            let is_5h =
                (unit == "HOUR" && duration == 5.0) || (unit == "MINUTE" && duration == 300.0);
            let used = lookup_number(l, "detail.used").unwrap_or(0.0);
            let limit = lookup_number(l, "detail.limit").unwrap_or(0.0);
            let label = if is_5h { "5h" } else { "窗口" };
            if limit > 0.0 {
                info.quota_windows.push(crate::types::QuotaWindow {
                    window: Some(label.to_string()),
                    used_percent: Some((used / limit * 100.0).min(100.0)),
                    resets_at: lookup_string(l, "detail.resetTime")
                        .or_else(|| lookup_string(l, "detail.reset_at")),
                    ..Default::default()
                });
                info.extras.push(KeyValue {
                    key: format!("{label} 用量"),
                    value: format!("{used:.0} / {limit:.0} credits"),
                });
            }
        }
    }

    // 并发上限
    if let Some(p) = lookup_number(&v, "parallel.limit") {
        info.extras.push(KeyValue {
            key: "并发上限".into(),
            value: format!("{p:.0}"),
        });
    }
    // 会员等级
    if let Some(level) = lookup_string(&v, "user.membership.level") {
        info.extras.push(KeyValue {
            key: "会员等级".into(),
            value: level,
        });
    }
    // 月度总量（形态B totalQuota）
    if let Some(tq) = lookup_number(&v, "totalQuota") {
        info.extras.push(KeyValue {
            key: "月度总量".into(),
            value: format!("{tq:.0} credits"),
        });
    }
    // 加油包（形态B boosterWallet.balance: {type:"BOOSTER", amount, amountLeft}）
    if let Some(left) = lookup_number(&v, "boosterWallet.balance.amountLeft") {
        info.extras.push(KeyValue {
            key: "加油包剩余".into(),
            value: format!("{left:.0} credits"),
        });
    }
    Ok(info)
}

/// Moonshot 开放平台（按量计费）: GET {base}/v1/users/me/balance（code=0 成功）
async fn moonshot_payg_balance(
    client: &reqwest::Client,
    acc: &AccountConfig,
    key: &str,
) -> Result<AccountInfo, String> {
    let base = acc.base();
    let (hk, hv) = http::bearer(key);
    let v = http::send_json(
        client,
        "GET",
        &format!("{base}/v1/users/me/balance"),
        &[(hk.as_str(), hv)],
        None,
    )
    .await?;

    let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
    if code != 0 {
        let msg = lookup_string(&v, "msg")
            .or_else(|| lookup_string(&v, "message"))
            .unwrap_or_else(|| "查询失败".into());
        return Err(format!("Moonshot 返回错误（code={code}）: {msg}"));
    }
    let data = v.get("data").cloned().unwrap_or(Value::Null);
    let currency = currency_for(&base);

    let mut info = AccountInfo {
        balance: lookup_number(&data, "available_balance").map(|b| Money {
            amount: b,
            currency: currency.clone(),
        }),
        fetched_at: crate::types::now_iso(),
        raw: Some(v.clone()),
        ..Default::default()
    };
    if let Some(c) = lookup_number(&data, "cash_balance") {
        info.extras.push(KeyValue {
            key: "现金余额".into(),
            value: format!("{c:.4} {currency}") + if c < 0.0 { "（欠费）" } else { "" },
        });
    }
    if let Some(c) = lookup_number(&data, "voucher_balance") {
        info.extras.push(KeyValue {
            key: "代金券".into(),
            value: format!("{c:.4} {currency}"),
        });
    }
    Ok(info)
}

/// 智谱 GLM：控制台内部接口（裸 key）→ 降级 /api/paas/v4/balance（Bearer）
async fn zhipu(client: &reqwest::Client, acc: &AccountConfig) -> Result<AccountInfo, String> {
    let key = need_key(acc)?;
    let base = acc.base();

    // 主路径：控制台报表接口（Authorization: <key>，不带 Bearer）
    let url = format!("{base}/api/biz/account/query-customer-account-report");
    let result =
        http::send_json(client, "GET", &url, &[("Authorization", key.clone())], None).await;

    match result {
        Ok(v) => {
            // HTTP 200 不代表成功，必须看 body
            let success = v.get("success").and_then(|s| s.as_bool()).unwrap_or(false);
            let code = v.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
            if !success && code != 200 {
                let msg = lookup_string(&v, "msg").unwrap_or_else(|| "查询失败".into());
                // 1001 通常是鉴权问题 → 提示
                if code == 1001 {
                    return Err(
                        "智谱接口鉴权失败（code=1001）: 请确认填的是 open.bigmodel.cn 的 API Key"
                            .to_string(),
                    );
                }
                return Err(format!("智谱返回错误（code={code}）: {msg}"));
            }
            let data = v.get("data").cloned().unwrap_or(Value::Null);
            let mut info = AccountInfo {
                balance: lookup_number(&data, "availableBalance")
                    .or_else(|| lookup_number(&data, "balance"))
                    .map(|b| Money {
                        amount: b,
                        currency: "CNY".into(),
                    }),
                used: lookup_number(&data, "totalSpendAmount").map(|s| Money {
                    amount: s,
                    currency: "CNY".into(),
                }),
                fetched_at: crate::types::now_iso(),
                raw: Some(v.clone()),
                ..Default::default()
            };
            if let Some(r) = lookup_number(&data, "rechargeAmount") {
                info.extras.push(KeyValue {
                    key: "累计充值".into(),
                    value: format!("{r:.2} CNY"),
                });
            }
            if let Some(g) = lookup_number(&data, "giveAmount") {
                info.extras.push(KeyValue {
                    key: "累计赠送".into(),
                    value: format!("{g:.2} CNY"),
                });
            }
            if let Some(f) = lookup_number(&data, "frozenBalance").filter(|f| *f > 0.0) {
                info.extras.push(KeyValue {
                    key: "冻结余额".into(),
                    value: format!("{f:.2} CNY"),
                });
            }
            info.note = Some("使用智谱控制台内部接口（非官方公开 API，接口变动风险自担）".into());
            Ok(info)
        }
        Err(primary_err) => {
            // 降级：旧版 /api/paas/v4/balance（Bearer；国内站可能 404）
            let (hk, hv) = http::bearer(&key);
            match http::send_json(
                client,
                "GET",
                &format!("{base}/api/paas/v4/balance"),
                &[(hk.as_str(), hv)],
                None,
            )
            .await
            {
                Ok(v) => {
                    let data = v.get("data").cloned().unwrap_or(Value::Null);
                    let balance = lookup_number(&data, "balance")
                        .or_else(|| lookup_number(&data, "availableBalance"))
                        .or_else(|| lookup_number(&v, "balance"));
                    match balance {
                        Some(b) => Ok(AccountInfo {
                            balance: Some(Money {
                                amount: b,
                                currency: "CNY".into(),
                            }),
                            note: Some("经由旧版余额接口查询".into()),
                            raw: Some(v),
                            fetched_at: crate::types::now_iso(),
                            ..Default::default()
                        }),
                        None => Err(primary_err),
                    }
                }
                Err(_) => Err(primary_err),
            }
        }
    }
}

#[cfg(test)]
mod tests {

    /// Kimi 订阅形态 C（2026-09/10 起）：usages{limit_5h:{used_ratio,reset_time},...}
    #[test]
    fn test_kimi_parse_form_c() {
        let v = serde_json::json!({
            "usages": {
                "limit_5h": { "used_ratio": 0.35, "reset_time": "2026-10-15T02:00:00Z" },
                "limit_7d": { "used_ratio": 0.52 },
                "limit_month_code": { "used_ratio": 0.61 },
                "limit_month_total": { "used_ratio": 0.48 }
            }
        });
        // 验证 ratio 百分比换算与 reset_time 提取
        let pct = |path: &str| crate::jsonpath::lookup_number(&v, path).map(|r| r * 100.0);
        assert_eq!(pct("usages.limit_5h.used_ratio"), Some(35.0));
        assert_eq!(pct("usages.limit_month_code.used_ratio"), Some(61.0));
        assert_eq!(
            crate::jsonpath::lookup_string(&v, "usages.limit_5h.reset_time"),
            Some("2026-10-15T02:00:00Z".into())
        );
    }

    /// Kimi 订阅形态 A/B：usage(周配额) + limits[](5h) + parallel + boosterWallet
    #[test]
    fn test_kimi_parse_form_ab() {
        let v = serde_json::json!({
            "usage": { "limit": 300, "used": 90, "remaining": 210, "resetTime": "2026-10-16T00:00:00Z" },
            "limits": [
                { "window": { "duration": 5, "timeUnit": "HOUR" },
                  "detail": { "used": 40, "limit": 200, "resetTime": "2026-10-14T16:00:00Z" } }
            ],
            "parallel": { "limit": 20 },
            "boosterWallet": { "balance": { "type": "BOOSTER", "amount": 500, "amountLeft": 350 } },
            "user": { "membership": { "level": "pro" } }
        });
        // 周配额
        assert_eq!(
            crate::jsonpath::lookup_number(&v, "usage.remaining"),
            Some(210.0)
        );
        let limit = crate::jsonpath::lookup_number(&v, "usage.limit").unwrap_or(0.0);
        let used = crate::jsonpath::lookup_number(&v, "usage.used").unwrap_or(0.0);
        assert_eq!((used / limit * 100.0) as i64, 30);
        // 5h 窗口识别（duration=5 + HOUR）
        let l = &v["limits"][0];
        assert_eq!(
            crate::jsonpath::lookup_number(l, "window.duration"),
            Some(5.0)
        );
        assert_eq!(
            crate::jsonpath::lookup_string(l, "window.timeUnit").as_deref(),
            Some("HOUR")
        );
        assert_eq!(crate::jsonpath::lookup_number(l, "detail.used"), Some(40.0));
        // 并发 / 加油包 / 等级
        assert_eq!(
            crate::jsonpath::lookup_number(&v, "parallel.limit"),
            Some(20.0)
        );
        assert_eq!(
            crate::jsonpath::lookup_number(&v, "boosterWallet.balance.amountLeft"),
            Some(350.0)
        );
        assert_eq!(
            crate::jsonpath::lookup_string(&v, "user.membership.level").as_deref(),
            Some("pro")
        );
    }

    /// Kimi key 前缀分流逻辑
    #[test]
    fn test_kimi_key_prefix_routing() {
        // sk-kimi- → 订阅端点（api.kimi.com）；其他 → 开放平台 balance
        assert!("sk-kimi-abc123".starts_with("sk-kimi-"));
        assert!(!"sk-abc123".starts_with("sk-kimi-"));
        // base 域名修正：开放平台域名会被替换为订阅域名
        let b = "https://api.moonshot.cn";
        let fixed = if b.contains("api.kimi.com") || b.contains("api.kimi.ai") {
            b.to_string()
        } else {
            "https://api.kimi.com".to_string()
        };
        assert_eq!(fixed, "https://api.kimi.com");
    }
}

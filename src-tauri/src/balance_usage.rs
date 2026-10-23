//! 余额差分的持久化增量账本。调用方先原子保存 records + checkpoints，再清理曲线快照。
use crate::types::{
    BalanceCheckpoint, BalanceSnapshot, UsageHistoryFile, UsageRecord, USAGE_SOURCE_LOCAL,
};
use chrono::{DateTime, FixedOffset};
use std::collections::{BTreeMap, HashMap};

fn currency(value: &str) -> String {
    let value = value.trim().to_uppercase();
    if value.is_empty() {
        "UNKNOWN".into()
    } else {
        value
    }
}

/// 只导入已有账号的实际观察；缺失的旧历史不补造。旧文件按原 local.updatedAt 迁移，
/// 此后只处理 checkpoint 之后的点，与原始快照是否仍保留无关。
pub fn ingest(
    file: &mut UsageHistoryFile,
    snapshots: &[BalanceSnapshot],
    account_ids: &[String],
    updated_at: &str,
) {
    let mut by_account: BTreeMap<&str, Vec<(DateTime<FixedOffset>, &BalanceSnapshot)>> =
        BTreeMap::new();
    for snapshot in snapshots {
        if !snapshot.balance.is_finite() || !account_ids.contains(&snapshot.account_id) {
            continue;
        }
        if let Ok(ts) = DateTime::parse_from_rfc3339(&snapshot.ts) {
            by_account
                .entry(&snapshot.account_id)
                .or_default()
                .push((ts, snapshot));
        }
    }
    for (account, mut points) in by_account {
        points.sort_by_key(|(ts, _)| *ts);
        let checkpoint_index = file
            .balance_checkpoints
            .iter()
            .position(|c| c.account_id == account);
        let checkpoint = checkpoint_index
            .and_then(|i| {
                let c = &file.balance_checkpoints[i];
                DateTime::parse_from_rfc3339(&c.ts)
                    .ok()
                    .filter(|_| c.balance.is_none_or(f64::is_finite))
                    .map(|t| (t, c.clone()))
            })
            .or_else(|| {
                // 旧账本处于 used 模式时，恢复余额仅建新基准，不跨越已计费区间。
                file.records
                    .iter()
                    .filter(|r| r.account_id == account && r.used_total.is_some())
                    .filter_map(|r| DateTime::parse_from_rfc3339(&r.updated_at).ok())
                    .max()
                    .map(|ts| {
                        (
                            ts,
                            BalanceCheckpoint {
                                account_id: account.into(),
                                ts: ts.to_rfc3339(),
                                balance: None,
                                currency: "UNKNOWN".into(),
                                used_mode_since: None,
                            },
                        )
                    })
            });
        let watermark = checkpoint.as_ref().map(|(ts, _)| *ts);
        // 迁移期间必须使用未修改过的旧记录时间，不让本批更新吞掉后续增量。
        let legacy: HashMap<String, Option<DateTime<FixedOffset>>> = if checkpoint.is_none() {
            file.records
                .iter()
                .filter(|r| r.account_id == account && !r.is_site())
                .map(|r| {
                    (
                        r.date.clone(),
                        DateTime::parse_from_rfc3339(&r.updated_at).ok(),
                    )
                })
                .collect()
        } else {
            HashMap::new()
        };
        let mut previous = checkpoint.map(|(_, c)| c);
        let mut rows: HashMap<String, usize> = file
            .records
            .iter()
            .enumerate()
            .filter(|(_, r)| r.account_id == account)
            .map(|(i, r)| (r.date.clone(), i))
            .collect();
        let mut changed = false;
        for (ts, snapshot) in points {
            if watermark.is_some_and(|watermark| ts <= watermark) {
                continue;
            }
            let unit = currency(&snapshot.currency);
            let date = ts.date_naive().to_string(); // 保留采样时间自身的时区日期。
            if let Some(prior) = previous
                .as_ref()
                .filter(|p| currency(&p.currency) == unit)
                .and_then(|p| p.balance)
            {
                let drop = prior - snapshot.balance;
                // 非法旧 updatedAt 无法证明哪些金额未入账：保留已有整日值，避免重复计费。
                let already_counted = legacy
                    .get(&date)
                    .is_some_and(|cutoff| cutoff.is_none_or(|t| ts <= t));
                if drop.is_finite() && drop > 0.0 && !already_counted {
                    if let Some(&index) = rows.get(&date) {
                        let row = &mut file.records[index];
                        if !row.is_site() && currency(&row.currency) == unit {
                            let cost = row.cost.unwrap_or(0.0) + drop;
                            if cost.is_finite() {
                                row.cost = Some(cost);
                                row.updated_at = updated_at.into();
                            }
                        }
                    } else {
                        rows.insert(date.clone(), file.records.len());
                        file.records.push(UsageRecord {
                            account_id: account.into(),
                            date,
                            cost: Some(drop),
                            currency: unit.clone(),
                            source: USAGE_SOURCE_LOCAL.into(),
                            updated_at: updated_at.into(),
                            ..Default::default()
                        });
                    }
                }
            }
            // 充值、零变化、site 优先、币种切换也前移，避免下一次跨过这些边界。
            previous = Some(BalanceCheckpoint {
                account_id: account.into(),
                ts: snapshot.ts.clone(),
                balance: Some(snapshot.balance),
                currency: unit,
                used_mode_since: None,
            });
            changed = true;
        }
        if changed {
            let checkpoint = previous.expect("有效观察必有基准");
            match checkpoint_index {
                Some(index) => file.balance_checkpoints[index] = checkpoint,
                None => file.balance_checkpoints.push(checkpoint),
            }
        }
    }
    file.balance_checkpoints
        .sort_by(|a, b| a.account_id.cmp(&b.account_id));
}

/// balance 缺失的成功观察形成模式边界；余额恢复后仅建立新基准。
pub fn reset(file: &mut UsageHistoryFile, account_ids: &[String], ts: &str) {
    for account in account_ids {
        let prior = file
            .balance_checkpoints
            .iter()
            .find(|c| c.account_id == *account);
        let used_mode_since = prior.and_then(|c| {
            if c.balance.is_some() {
                Some(ts.into())
            } else {
                c.used_mode_since.clone()
            }
        });
        let next = BalanceCheckpoint {
            account_id: account.clone(),
            ts: ts.into(),
            balance: None,
            currency: "UNKNOWN".into(),
            used_mode_since,
        };
        match file
            .balance_checkpoints
            .iter_mut()
            .find(|c| c.account_id == *account)
        {
            Some(checkpoint) => *checkpoint = next,
            None => file.balance_checkpoints.push(next),
        }
    }
    file.balance_checkpoints
        .sort_by(|a, b| a.account_id.cmp(&b.account_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(ts: &str, balance: f64, currency: &str) -> BalanceSnapshot {
        BalanceSnapshot {
            ts: ts.into(),
            account_id: "a".into(),
            balance,
            currency: currency.into(),
            total: None,
        }
    }
    fn apply(file: &mut UsageHistoryFile, points: &[BalanceSnapshot]) {
        ingest(file, points, &["a".into()], "2026-10-23T12:00:00Z");
    }
    fn sum(file: &UsageHistoryFile) -> f64 {
        file.records.iter().filter_map(|r| r.cost).sum()
    }

    #[test]
    fn replay_restart_and_pruned_history_only_add_new_drops() {
        let mut file = UsageHistoryFile::default();
        let first = point("2026-10-23T09:00:00Z", 100.0, "USD");
        let second = point("2026-10-23T10:00:00Z", 90.0, "USD");
        apply(&mut file, &[first, second.clone()]);
        assert_eq!(sum(&file), 10.0);
        let bytes = serde_json::to_vec(&file).unwrap();
        let mut file: UsageHistoryFile = serde_json::from_slice(&bytes).unwrap();
        let next = point("2026-10-23T11:00:00Z", 89.0, "USD");
        apply(&mut file, &[second, next.clone()]);
        assert_eq!(sum(&file), 11.0);
        let saved = file.clone();
        apply(&mut file, &[next]);
        assert_eq!(file, saved, "重复刷新、重新加载均不得重复计费");
    }

    #[test]
    fn deposits_and_flat_observations_advance_baseline() {
        let mut file = UsageHistoryFile::default();
        for (hour, balance) in [(6, 100.0), (10, 50.0), (14, 80.0), (16, 80.0), (18, 40.0)] {
            apply(
                &mut file,
                &[point(
                    &format!("2026-10-23T{hour:02}:00:00Z"),
                    balance,
                    "USD",
                )],
            );
        }
        assert_eq!(sum(&file), 90.0);
        assert_eq!(file.balance_checkpoints[0].balance, Some(40.0));
        let mut empty = UsageHistoryFile::default();
        apply(&mut empty, &[point("2026-10-23T10:00:00Z", 0.0, "USD")]);
        assert!(empty.records.is_empty());
        assert_eq!(empty.balance_checkpoints.len(), 1);
    }

    #[test]
    fn local_dates_currency_boundaries_and_account_scope_are_preserved() {
        let mut file = UsageHistoryFile::default();
        apply(
            &mut file,
            &[
                point("2026-10-22T23:59:00+08:00", 100.0, " usd "),
                point("2026-10-23T00:01:00+08:00", 90.0, "USD"),
                point("2026-10-23T01:00:00+08:00", 600.0, "CNY"),
                point("2026-10-23T02:00:00+08:00", 590.0, "CNY"),
                point("2026-10-24T00:01:00+08:00", 580.0, "CNY"),
            ],
        );
        assert_eq!(file.records.len(), 2);
        assert_eq!(
            (
                &file.records[0].date,
                &file.records[0].currency,
                file.records[0].cost
            ),
            (&"2026-10-23".into(), &"USD".into(), Some(10.0))
        );
        assert_eq!(file.records[1].cost, Some(10.0));
        assert_eq!(file.records[1].currency, "CNY");
        let prior = file.clone();
        let mut unrelated = point("2026-10-25T00:00:00Z", 1.0, "USD");
        unrelated.account_id = "disabled".into();
        apply(
            &mut file,
            &[
                unrelated,
                point("bad", 1.0, "USD"),
                point("2026-10-25T00:00:00Z", f64::NAN, "USD"),
            ],
        );
        assert_eq!(file, prior);
    }

    #[test]
    fn legacy_migration_preserves_full_days_and_adds_all_new_deltas_once() {
        let mut file = UsageHistoryFile::default();
        file.records.push(UsageRecord {
            account_id: "a".into(),
            date: "2026-10-23".into(),
            cost: Some(10.0),
            currency: "USD".into(),
            source: "local".into(),
            updated_at: "2026-10-23T10:00:00Z".into(),
            ..Default::default()
        });
        let points = [
            point("2026-10-23T09:00:00Z", 100.0, "USD"),
            point("2026-10-23T10:00:00Z", 90.0, "USD"),
            point("2026-10-23T11:00:00Z", 89.0, "USD"),
            point("2026-10-23T12:00:00Z", 88.0, "USD"),
        ];
        apply(&mut file, &points);
        assert_eq!(sum(&file), 12.0, "迁移时已有10不重复加，新1+1都要加");
        let saved = file.clone();
        apply(&mut file, &points);
        assert_eq!(file, saved);
    }

    #[test]
    fn site_priority_does_not_freeze_the_balance_checkpoint() {
        let mut file = UsageHistoryFile::default();
        file.records.push(UsageRecord {
            account_id: "a".into(),
            date: "2026-10-23".into(),
            cost: Some(5.0),
            currency: "USD".into(),
            source: "site".into(),
            ..Default::default()
        });
        apply(
            &mut file,
            &[
                point("2026-10-23T09:00:00Z", 100.0, "USD"),
                point("2026-10-23T10:00:00Z", 90.0, "USD"),
            ],
        );
        assert_eq!(sum(&file), 5.0);
        apply(&mut file, &[point("2026-10-24T10:00:00Z", 89.0, "USD")]);
        assert_eq!(file.records[1].cost, Some(1.0));
    }

    #[test]
    fn observations_in_the_same_second_keep_nanosecond_precision() {
        let mut file = UsageHistoryFile::default();
        apply(
            &mut file,
            &[point("2026-10-23T10:00:00.000000001Z", 100.0, "USD")],
        );
        apply(
            &mut file,
            &[point("2026-10-23T10:00:00.000000002Z", 90.0, "USD")],
        );
        apply(
            &mut file,
            &[point("2026-10-23T10:00:00.000000003Z", 89.0, "USD")],
        );
        assert_eq!(sum(&file), 11.0);
        apply(
            &mut file,
            &[point("2026-10-23T10:00:00.000000002Z", 90.0, "USD")],
        );
        assert_eq!(sum(&file), 11.0, "乱序重放不能回退基准");
    }

    #[test]
    fn used_mode_boundaries_prevent_balance_and_counter_double_counting() {
        let mut file = UsageHistoryFile::default();
        apply(&mut file, &[point("2026-10-23T09:00:00Z", 100.0, "USD")]);
        reset(&mut file, &["a".into()], "2026-10-23T10:00:00Z");
        assert_eq!(
            file.balance_checkpoints[0].used_mode_since.as_deref(),
            Some("2026-10-23T10:00:00Z")
        );
        reset(&mut file, &["a".into()], "2026-10-23T11:00:00Z");
        assert_eq!(
            file.balance_checkpoints[0].used_mode_since.as_deref(),
            Some("2026-10-23T10:00:00Z")
        );
        apply(&mut file, &[point("2026-10-23T12:00:00Z", 90.0, "USD")]);
        assert_eq!(sum(&file), 0.0, "恢复余额时不跨越 used 模式再计费");
        apply(&mut file, &[point("2026-10-23T13:00:00Z", 89.0, "USD")]);
        assert_eq!(sum(&file), 1.0);
    }
}

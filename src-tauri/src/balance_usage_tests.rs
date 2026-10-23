//! 真正经过账本原子落盘与曲线保留策略的回归测试。
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Fixture {
    dir: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target/test-tmp")
            .join(format!(
                "balance-ledger-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }
    fn history(&self) -> PathBuf {
        self.dir.join("history.json")
    }
    fn usage(&self) -> PathBuf {
        self.dir.join("usage-history.json")
    }
    fn record(&self, points: &[BalanceSnapshot], now: &str) -> Result<(), String> {
        record_balance_history_at(
            &self.history(),
            &self.usage(),
            points,
            &["a".into()],
            &[],
            now,
            chrono::DateTime::parse_from_rfc3339(now)
                .unwrap()
                .timestamp_millis(),
        )
    }
    fn ledger(&self) -> UsageHistoryFile {
        load_usage_history(&self.usage()).unwrap()
    }
    fn sum(&self) -> f64 {
        self.ledger().records.iter().filter_map(|r| r.cost).sum()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
fn point(ts: &str, balance: f64) -> BalanceSnapshot {
    BalanceSnapshot {
        ts: ts.into(),
        account_id: "a".into(),
        balance,
        currency: "USD".into(),
        total: None,
    }
}

#[test]
fn spend_10_prune_at_150000_then_spend_1_still_persists_11() {
    let fixture = Fixture::new();
    let start = chrono::DateTime::parse_from_rfc3339("2026-10-23T00:00:00Z").unwrap();
    let before: Vec<_> = (0..MAX_HISTORY_PER_ACCOUNT)
        .map(|i| {
            point(
                &(start + chrono::Duration::milliseconds(i as i64 * 100)).to_rfc3339(),
                if i == 0 { 100.0 } else { 90.0 },
            )
        })
        .collect();
    fixture.record(&before, "2026-10-23T05:00:00Z").unwrap();
    assert_eq!(fixture.sum(), 10.0);
    let next = point("2026-10-23T12:00:00Z", 89.0);
    fixture
        .record(std::slice::from_ref(&next), &next.ts)
        .unwrap();
    let retained = load_history(&fixture.history()).unwrap();
    assert_eq!(retained.len(), MAX_HISTORY_PER_ACCOUNT);
    assert_eq!(retained[0].balance, 90.0, "早期100快照已真实淘汰");
    assert_eq!(fixture.sum(), 11.0);
    let saved = fixture.ledger(); // 模拟下一次刷新从磁盘重载，不能依赖内存基准。
    fixture.record(&[next], "2026-10-23T12:00:00Z").unwrap();
    assert_eq!(fixture.ledger(), saved, "重启/重放不重复累计");
}

#[test]
fn ninety_day_boundary_cannot_replace_a_full_old_day_with_partial_cost() {
    let fixture = Fixture::new();
    fixture
        .record(
            &[
                point("2026-07-25T00:00:00Z", 100.0),
                point("2026-07-25T08:00:00Z", 90.0),
                point("2026-07-25T12:30:00Z", 90.0),
                point("2026-07-25T13:00:00Z", 89.0),
            ],
            "2026-07-25T13:00:00Z",
        )
        .unwrap();
    assert_eq!(fixture.sum(), 11.0);
    fixture
        .record(
            &[point("2026-10-23T12:00:00Z", 89.0)],
            "2026-10-23T12:00:00Z",
        )
        .unwrap();
    assert_eq!(
        load_history(&fixture.history()).unwrap().len(),
        3,
        "90天边界真实截断旧日期"
    );
    assert_eq!(fixture.ledger().records[0].date, "2026-07-25");
    assert_eq!(fixture.sum(), 11.0);
}

#[test]
fn migrate_legacy_partial_snapshots_preserves_existing_complete_day() {
    let fixture = Fixture::new();
    fs::write(fixture.usage(), serde_json::json!({"version":1,"records":[{
        "accountId":"a","date":"2026-07-25","cost":11.0,"currency":"USD","source":"local","updatedAt":"2026-07-25T13:00:00Z"
    }]}).to_string()).unwrap();
    save_history(
        &fixture.history(),
        &[
            point("2026-07-25T12:30:00Z", 90.0),
            point("2026-07-25T13:00:00Z", 89.0),
        ],
    )
    .unwrap();
    fixture
        .record(
            &[point("2026-10-23T12:00:00Z", 89.0)],
            "2026-10-23T12:00:00Z",
        )
        .unwrap();
    assert_eq!(fixture.sum(), 11.0);
    assert_eq!(fixture.ledger().balance_checkpoints.len(), 1);
}

#[test]
fn ledger_write_failure_preserves_untrimmed_points_and_retries_exactly_once() {
    let fixture = Fixture::new();
    fixture
        .record(
            &[
                point("2026-07-25T11:59:00Z", 100.0),
                point("2026-07-25T12:00:00Z", 90.0),
            ],
            "2026-07-25T12:00:00Z",
        )
        .unwrap();
    let saved = fs::read(fixture.usage()).unwrap();
    let blocker = fixture.usage().with_file_name("usage-history.json.tmp");
    fs::create_dir(&blocker).unwrap();
    let now = "2026-10-23T12:01:00Z";
    assert!(fixture.record(&[point(now, 89.0)], now).is_err());
    assert_eq!(
        fs::read(fixture.usage()).unwrap(),
        saved,
        "失败不得推进累计或基准"
    );
    assert_eq!(
        load_history(&fixture.history()).unwrap().len(),
        3,
        "账本失败时过期点也不能清理"
    );
    fs::remove_dir(blocker).unwrap();
    fixture.record(&[], now).unwrap();
    assert_eq!(fixture.sum(), 11.0);
    assert_eq!(load_history(&fixture.history()).unwrap().len(), 1);
    let saved = fixture.ledger();
    fixture.record(&[], now).unwrap();
    assert_eq!(fixture.ledger(), saved);
}

#[test]
fn history_write_failure_after_ledger_commit_is_safe_to_replay() {
    let fixture = Fixture::new();
    fixture
        .record(
            &[
                point("2026-10-23T09:00:00Z", 100.0),
                point("2026-10-23T10:00:00Z", 90.0),
            ],
            "2026-10-23T10:00:00Z",
        )
        .unwrap();
    let blocker = fixture.history().with_extension("json.tmp");
    fs::create_dir(&blocker).unwrap();
    let next = point("2026-10-23T11:00:00Z", 89.0);
    assert!(fixture
        .record(std::slice::from_ref(&next), &next.ts)
        .is_err());
    assert_eq!(fixture.sum(), 11.0);
    fs::remove_dir(blocker).unwrap();
    fixture.record(&[next], "2026-10-23T11:00:00Z").unwrap();
    assert_eq!(fixture.sum(), 11.0);
}

#[test]
fn concurrent_site_upserts_preserve_committed_balance_checkpoints() {
    let fixture = Fixture::new();
    fixture
        .record(
            &[point("2026-10-23T09:00:00Z", 100.0)],
            "2026-10-23T09:00:00Z",
        )
        .unwrap();
    std::thread::scope(|scope| {
        for i in 0..6 {
            let usage = fixture.usage();
            scope.spawn(move || {
                upsert_usage_history(
                    &usage,
                    &[UsageRecord {
                        account_id: format!("site-{i}"),
                        date: "2026-10-23".into(),
                        cost: Some(5.0),
                        currency: "USD".into(),
                        source: "site".into(),
                        ..Default::default()
                    }],
                )
                .unwrap();
            });
        }
        scope.spawn(|| {
            fixture
                .record(
                    &[point("2026-10-23T10:00:00Z", 90.0)],
                    "2026-10-23T10:00:00Z",
                )
                .unwrap()
        });
    });
    assert_eq!(fixture.ledger().records.len(), 7);
    assert_eq!(fixture.sum(), 40.0);
    assert_eq!(fixture.ledger().balance_checkpoints[0].balance, Some(90.0));
}

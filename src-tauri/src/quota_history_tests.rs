use super::*;
use crate::types::QuotaWindow;

const DAY: i64 = 86_400_000;
fn base() -> i64 {
    DateTime::parse_from_rfc3339("2026-10-01T00:00:00Z")
        .unwrap()
        .timestamp_millis()
}
fn iso(ms: i64) -> String {
    DateTime::from_timestamp_millis(ms).unwrap().to_rfc3339()
}
fn info(at: i64, used: f64, reset: Option<i64>) -> AccountInfo {
    AccountInfo {
        fetched_at: iso(at),
        quota_scope: Some("workspace-a".into()),
        quota_windows: vec![QuotaWindow {
            window: Some("Codex · 每周".into()),
            history_key: Some("codex:604800".into()),
            window_seconds: Some(604800),
            used_percent: Some(used),
            resets_at: reset.map(iso),
            ..Default::default()
        }],
        ..Default::default()
    }
}
fn push(file: &mut File, at: i64, used: f64, reset: Option<i64>) {
    assert!(append(file, &info(at, used, reset), at, MAX_SAMPLES).unwrap());
}
fn point(file: &File) -> &QuotaPoint {
    &file.samples.last().unwrap().windows[0]
}

#[test]
fn multiple_ad_hoc_resets_in_one_day_do_not_require_seven_days_or_a_new_deadline() {
    let t = base();
    let deadline = t + 7 * DAY;
    let mut file = File::default();
    push(&mut file, t, 80.0, Some(deadline));
    push(&mut file, t + 1000, 0.0, Some(deadline));
    assert_eq!(point(&file).segment, 2);
    assert_eq!(point(&file).boundary, Some(Boundary::UsageDecreased));
    push(&mut file, t + 2000, 15.0, Some(deadline));
    assert_eq!(point(&file).segment, 2);
    push(&mut file, t + 3000, 0.0, Some(deadline));
    assert_eq!(point(&file).segment, 3);
    assert_eq!(
        file.samples
            .iter()
            .map(|s| s.windows[0].used_percent)
            .collect::<Vec<_>>(),
        [80.0, 0.0, 15.0, 0.0]
    );
}

#[test]
fn early_reset_with_new_deadline_and_schedule_only_changes_are_kept_distinct() {
    let t = base();
    let mut file = File::default();
    push(&mut file, t, 80.0, Some(t + 7 * DAY));
    push(&mut file, t + DAY, 0.0, Some(t + 3 * DAY));
    assert_eq!(point(&file).boundary, Some(Boundary::UsageDecreased));
    push(&mut file, t + DAY + 1000, 0.0, Some(t + 5 * DAY));
    assert_eq!(point(&file).boundary, Some(Boundary::ScheduleChanged));
    assert_eq!(point(&file).used_percent, 0.0);
    push(&mut file, t + DAY + 2000, 10.0, Some(t + 2 * DAY));
    assert_eq!(point(&file).boundary, Some(Boundary::ScheduleChanged));
    assert_eq!(point(&file).used_percent, 10.0); // Never synthesize a zero for a schedule update.
}

#[test]
fn response_clock_jitter_does_not_split_a_period_and_drift_cannot_move_the_anchor_forever() {
    let t = base();
    let reset = t + 7 * DAY;
    let mut file = File::default();
    push(&mut file, t, 1.0, Some(reset));
    for (i, offset) in [1000, -1000, 30_000, -30_000, 60_000]
        .into_iter()
        .enumerate()
    {
        push(
            &mut file,
            t + (i as i64 + 1) * 1000,
            2.0 + i as f64,
            Some(reset + offset),
        );
        assert_eq!(point(&file).segment, 1);
        assert_eq!(point(&file).boundary, None);
    }
    push(&mut file, t + 10_000, 8.0, Some(reset + 61_000));
    assert_eq!(point(&file).boundary, Some(Boundary::ScheduleChanged));
}

#[test]
fn unknown_deadline_does_not_create_calendar_weeks_and_a_decrease_still_splits() {
    let t = base();
    let mut file = File::default();
    push(&mut file, t, 10.0, None);
    push(&mut file, t + 8 * DAY, 20.0, None);
    assert_eq!(point(&file).segment, 1);
    push(&mut file, t + 8 * DAY + 1000, 0.0, None);
    assert_eq!(point(&file).boundary, Some(Boundary::UsageDecreased));
    assert_eq!(point(&file).resets_at, None);
}

#[test]
fn stale_deadline_and_observed_rollover_do_not_fabricate_weekly_zeroes() {
    let t = base();
    let deadline = t + DAY;
    let mut file = File::default();
    push(&mut file, t, 70.0, Some(deadline));
    push(&mut file, deadline, 70.0, Some(deadline));
    assert_eq!(point(&file).boundary, Some(Boundary::Expired));
    push(&mut file, deadline + 1000, 70.0, Some(deadline));
    assert_eq!(point(&file).boundary, None);
    assert_eq!(point(&file).segment, 2);
    push(
        &mut file,
        deadline + 2000,
        4.0,
        Some(deadline + 36 * 3_600_000),
    );
    assert_eq!(point(&file).boundary, Some(Boundary::Reset));
    assert_eq!(point(&file).used_percent, 4.0);
    assert_eq!(point(&file).segment, 3);
}

#[test]
fn deadline_extension_is_not_a_confirmed_reset_and_jitter_near_deadline_is_not_expiration() {
    let t = base();
    let deadline = t + DAY;
    let mut file = File::default();
    push(&mut file, t, 70.0, Some(deadline));
    push(&mut file, deadline + 30_000, 71.0, Some(deadline + 60_000));
    assert_eq!(point(&file).boundary, None);
    push(&mut file, deadline + 61_000, 71.0, Some(deadline + 60_000));
    assert_eq!(point(&file).boundary, Some(Boundary::Expired));
    push(&mut file, deadline + 62_000, 71.0, Some(deadline + 60_000));
    assert_eq!(point(&file).boundary, None);
    push(&mut file, deadline + 70_000, 72.0, Some(deadline + DAY));
    assert_eq!(point(&file).boundary, Some(Boundary::ScheduleChanged));
    assert_eq!(point(&file).used_percent, 72.0);
}

#[test]
fn disappeared_windows_and_workspace_switches_cannot_share_a_curve_segment() {
    let t = base();
    let mut file = File::default();
    push(&mut file, t, 70.0, None);
    let mut missing = info(t + 1000, 0.0, None);
    missing.quota_windows.clear();
    append(&mut file, &missing, t + 1000, MAX_SAMPLES).unwrap();
    push(&mut file, t + 2000, 71.0, None);
    assert_eq!(point(&file).boundary, Some(Boundary::WindowReturned));
    let mut other = info(t + 3000, 1.0, None);
    other.quota_scope = Some("workspace-b".into());
    append(&mut file, &other, t + 3000, MAX_SAMPLES).unwrap();
    assert_eq!(point(&file).segment, 1);
    assert_eq!(point(&file).boundary, None);
    push(&mut file, t + 4000, 72.0, None);
    assert_eq!(point(&file).boundary, Some(Boundary::WindowReturned));
    assert_eq!(point(&file).segment, 3);
}

#[test]
fn sub_millisecond_samples_are_distinct_and_old_or_duplicate_responses_do_not_rewind_state() {
    let t = base();
    let mut file = File::default();
    let mut a = info(t, 10.0, None);
    a.fetched_at = "2026-10-01T00:00:00.000000001Z".into();
    append(&mut file, &a, t, MAX_SAMPLES).unwrap();
    let mut b = a.clone();
    b.fetched_at = "2026-10-01T00:00:00.000000002Z".into();
    b.quota_windows[0].used_percent = Some(11.0);
    append(&mut file, &b, t, MAX_SAMPLES).unwrap();
    assert_eq!(file.samples.len(), 2);
    assert!(!append(&mut file, &a, t, MAX_SAMPLES).unwrap());
    assert!(!append(&mut file, &b, t, MAX_SAMPLES).unwrap());
    b.quota_windows[0].used_percent = Some(0.0);
    assert!(append(&mut file, &b, t, MAX_SAMPLES).is_err());
    assert_eq!(point(&file).used_percent, 11.0);
    assert_eq!(point(&file).segment, 1);
}

#[test]
fn retention_preserves_boundary_sample_and_checkpoints_even_when_early_periods_are_gone() {
    let t = base();
    let mut file = File::default();
    push(&mut file, t, 60.0, None);
    push(&mut file, t + 1000, 0.0, None);
    let next = info(t + 90 * DAY + 1000, 20.0, None);
    append(&mut file, &next, t + 90 * DAY + 1000, MAX_SAMPLES).unwrap();
    assert_eq!(file.samples.len(), 2);
    assert_eq!(file.samples[0].ts, iso(t + 1000));
    assert_eq!(point(&file).segment, 2);
    // A record outside retention can leave zero curve points; the cursor must still reject late data.
    let mut empty = File::default();
    append(&mut empty, &info(t, 70.0, None), t + 91 * DAY, MAX_SAMPLES).unwrap();
    assert!(empty.samples.is_empty());
    assert!(!append(
        &mut empty,
        &info(t - 1000, 0.0, None),
        t + 91 * DAY,
        MAX_SAMPLES
    )
    .unwrap());
}

#[test]
fn the_real_150000_sample_limit_does_not_renumber_surviving_segments() {
    let t = base();
    let mut file = File::default();
    push(&mut file, t, 60.0, None);
    push(&mut file, t + 1, 0.0, None);
    let template = file.samples.last().unwrap().clone();
    file.samples = (1..=MAX_SAMPLES)
        .map(|i| QuotaSample {
            ts: iso(t + i as i64),
            ..template.clone()
        })
        .collect();
    file.last_observed = Some(iso(t + MAX_SAMPLES as i64));
    for tracker in file.trackers.values_mut() {
        tracker.last_seen = file.last_observed.clone().unwrap();
    }
    push(&mut file, t + MAX_SAMPLES as i64 + 1, 10.0, None);
    assert_eq!(file.samples.len(), MAX_SAMPLES);
    assert_eq!(file.samples[0].ts, iso(t + 2));
    assert_eq!(point(&file).segment, 2);
    push(&mut file, t + MAX_SAMPLES as i64 + 2, 0.0, None);
    assert_eq!(point(&file).segment, 3);
}

#[test]
fn damaged_files_and_failed_writes_preserve_last_committed_history_and_segment_state() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "llm-quota-history-test-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("history.json");
    std::fs::write(&path, b"invalid-json").unwrap();
    assert!(record_at(&path, &info(base(), 60.0, None), base(), MAX_SAMPLES).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"invalid-json");
    std::fs::remove_file(&path).unwrap();
    record_at(&path, &info(base(), 60.0, None), base(), MAX_SAMPLES).unwrap();
    let committed = std::fs::read(&path).unwrap();
    let temp = root.join("history.json.tmp");
    std::fs::create_dir(&temp).unwrap();
    let next = info(base() + 1000, 0.0, None);
    assert!(record_at(&path, &next, base() + 1000, MAX_SAMPLES).is_err());
    assert_eq!(std::fs::read(&path).unwrap(), committed);
    std::fs::remove_dir(&temp).unwrap();
    record_at(&path, &next, base() + 1000, MAX_SAMPLES).unwrap();
    let restarted = load(&path).unwrap();
    assert_eq!(point(&restarted).segment, 2);
    assert_eq!(point(&restarted).used_percent, 0.0);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn unchanged_samples_within_thirty_seconds_skip_writes_without_hiding_boundaries() {
    let t = base();
    let reset = t + 10_000;
    let mut file = File::default();
    push(&mut file, t, 60.0, Some(reset));
    assert!(!append(
        &mut file,
        &info(t + 1000, 60.0, Some(reset)),
        t + 1000,
        MAX_SAMPLES
    )
    .unwrap());
    assert_eq!(file.samples.len(), 1);

    // The deadline still creates a boundary even though the percentage is unchanged.
    push(&mut file, reset, 60.0, Some(reset));
    assert_eq!(point(&file).boundary, Some(Boundary::Expired));
    assert_eq!(file.samples.len(), 2);

    // Keep one ordinary sample after a boundary so later samples can skip again.
    push(&mut file, reset + 1000, 60.0, Some(reset));
    assert_eq!(point(&file).boundary, None);
    assert!(!append(
        &mut file,
        &info(reset + 2000, 60.0, Some(reset)),
        reset + 2000,
        MAX_SAMPLES
    )
    .unwrap());
    assert_eq!(file.samples.len(), 3);
    push(&mut file, reset + 31_000, 60.0, Some(reset));
    assert_eq!(file.samples.len(), 4);
}

#[test]
fn incremental_queries_are_scope_isolated_and_strictly_after_the_cursor() {
    let t = base();
    let mut file = File::default();
    push(&mut file, t, 10.0, None);
    push(&mut file, t + 1000, 20.0, None);
    let mut other = info(t + 2000, 30.0, None);
    other.quota_scope = Some("workspace-b".into());
    append(&mut file, &other, t + 2000, MAX_SAMPLES).unwrap();

    let selected = select_samples(file.clone(), "workspace-a", Some(&iso(t))).unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].ts, iso(t + 1000));
    assert_eq!(selected[0].windows[0].used_percent, 20.0);
    assert_eq!(
        select_samples(file.clone(), "workspace-a", None)
            .unwrap()
            .len(),
        2
    );
    assert!(select_samples(file, "workspace-a", Some("not-a-time")).is_err());
}

#[test]
fn incremental_queries_preserve_sub_millisecond_samples() {
    let t = base();
    let mut file = File::default();
    let mut first = info(t, 10.0, None);
    first.fetched_at = "2026-10-01T00:00:00.000000001Z".into();
    append(&mut file, &first, t, MAX_SAMPLES).unwrap();
    let mut second = first.clone();
    second.fetched_at = "2026-10-01T00:00:00.000000002Z".into();
    second.quota_windows[0].used_percent = Some(11.0);
    append(&mut file, &second, t, MAX_SAMPLES).unwrap();

    let selected = select_samples(file, "workspace-a", Some(&first.fetched_at)).unwrap();
    assert_eq!(selected.len(), 1);
    assert_eq!(selected[0].ts, second.fetched_at);
}

#[test]
fn skipped_samples_persist_the_high_water_without_rewriting_history() {
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "llm-quota-history-cursor-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("history.json");
    let t = base();
    record_at(&path, &info(t, 60.0, None), t, MAX_SAMPLES).unwrap();
    let committed = std::fs::read(&path).unwrap();

    record_at(&path, &info(t + 2000, 60.0, None), t + 2000, MAX_SAMPLES).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), committed);
    assert_eq!(
        std::fs::read_to_string(cursor_path(&path)).unwrap(),
        iso(t + 2000)
    );
    let restarted = load(&path).unwrap();
    assert_eq!(restarted.last_observed, Some(iso(t + 2000)));

    // A late response cannot rewind the checkpoint or create a usage-decrease boundary.
    record_at(&path, &info(t + 1000, 0.0, None), t + 1000, MAX_SAMPLES).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), committed);
    let conflict = record_at(&path, &info(t + 2000, 0.0, None), t + 2000, MAX_SAMPLES);
    assert!(conflict.is_err());
    assert_eq!(std::fs::read(&path).unwrap(), committed);

    // The next real sample follows the last retained sample, not a fabricated window return.
    record_at(&path, &info(t + 3000, 61.0, None), t + 3000, MAX_SAMPLES).unwrap();
    let updated = load(&path).unwrap();
    assert_eq!(point(&updated).boundary, None);
    assert_eq!(point(&updated).used_percent, 61.0);
    std::fs::remove_dir_all(root).unwrap();
}

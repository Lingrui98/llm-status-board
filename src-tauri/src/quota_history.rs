//! Percentage samples are independent of the monetary usage ledger. Cycle/segment state
//! is committed with samples before retention, and never reconstructed from a truncated week.
use crate::types::AccountInfo;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

const VERSION: u32 = 1;
const MAX_SAMPLES: usize = 150_000;
const UNCHANGED_SAMPLE_MIN_MS: i64 = 30_000;
const RESET_JITTER_MS: i64 = 60_000;
const DROP_EPSILON: f64 = 0.000001;
static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSample {
    pub ts: String,
    pub scope: String,
    pub windows: Vec<QuotaPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct QuotaPoint {
    pub key: String,
    pub label: String,
    pub used_percent: f64,
    pub resets_at: Option<String>,
    pub window_seconds: Option<i64>,
    pub segment: u64,
    pub boundary: Option<Boundary>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum Boundary {
    Reset,
    ScheduleChanged,
    UsageDecreased,
    WindowReturned,
    Expired,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tracker {
    last_seen: String,
    last_used: f64,
    // Fixed anchor within the tolerance band: repeated small clock drift cannot move it forever.
    reset_anchor_ms: Option<i64>,
    segment: u64,
    #[serde(default)]
    deadline_expired: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct File {
    version: u32,
    samples: Vec<QuotaSample>,
    trackers: HashMap<String, Tracker>,
    last_observed: Option<String>,
}
impl Default for File {
    fn default() -> Self {
        Self {
            version: VERSION,
            samples: Vec::new(),
            trackers: HashMap::new(),
            last_observed: None,
        }
    }
}

fn timestamp(value: &str) -> Result<i64, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|ts| ts.timestamp_millis())
        .map_err(|_| "订阅历史时间格式无效".into())
}

fn file_path(app: &tauri::AppHandle, account_id: &str) -> Result<PathBuf, String> {
    let root = app
        .path()
        .app_config_dir()
        .map_err(|_| "无法确定订阅历史目录".to_string())?;
    Ok(root
        .join("quota-history")
        .join(format!("{:x}.json", Sha256::digest(account_id))))
}

fn cursor_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".cursor");
    PathBuf::from(value)
}

fn load(path: &Path) -> Result<File, String> {
    let mut file = if path.exists() {
        let data = std::fs::read(path).map_err(|_| "读取订阅额度历史失败".to_string())?;
        let file: File = serde_json::from_slice(&data)
            .map_err(|_| "订阅额度历史文件损坏，原文件已保留".to_string())?;
        if file.version != VERSION {
            return Err("订阅额度历史版本不受支持，原文件已保留".into());
        }
        file
    } else {
        File::default()
    };
    let cursor = match std::fs::read_to_string(cursor_path(path)) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(file),
        Err(_) => return Err("读取订阅额度历史游标失败".into()),
    };
    let observed = cursor.trim();
    let cursor_time = DateTime::parse_from_rfc3339(observed)
        .map_err(|_| "订阅额度历史游标格式无效".to_string())?;
    let current = file
        .last_observed
        .as_deref()
        .map(DateTime::parse_from_rfc3339)
        .transpose()
        .map_err(|_| "订阅历史时间格式无效".to_string())?;
    if current.is_none_or(|current| cursor_time > current) {
        file.last_observed = Some(observed.into());
    }
    Ok(file)
}

fn boundary(
    previous: &Tracker,
    at: i64,
    reset: Option<i64>,
    used: f64,
    previous_sample: Option<&str>,
) -> Option<Boundary> {
    let changed = previous
        .reset_anchor_ms
        .zip(reset)
        .is_some_and(|(a, b)| (i128::from(a) - i128::from(b)).abs() > i128::from(RESET_JITTER_MS));
    let expired = previous
        .reset_anchor_ms
        .is_some_and(|deadline| at >= deadline);
    let decreased = used + DROP_EPSILON < previous.last_used;
    // Only call a rollover when a decrease is also observed. A later deadline alone
    // could be an extension, even after the previously advertised time has passed.
    if decreased && expired {
        return Some(Boundary::Reset);
    }
    if decreased {
        return Some(Boundary::UsageDecreased);
    }
    if changed {
        return Some(Boundary::ScheduleChanged);
    }
    if previous_sample != Some(previous.last_seen.as_str()) {
        return Some(Boundary::WindowReturned);
    }
    if !previous.deadline_expired
        && reset
            .or(previous.reset_anchor_ms)
            .is_some_and(|deadline| at >= deadline)
    {
        return Some(Boundary::Expired);
    }
    None
}

fn can_skip_unchanged(file: &File, info: &AccountInfo, scope: &str, at: i64) -> bool {
    let Some(previous_sample) = file.samples.last() else {
        return false;
    };
    if previous_sample.scope != scope
        || previous_sample.windows.len() != info.quota_windows.len()
        || previous_sample.windows.iter().any(|w| w.boundary.is_some())
    {
        return false;
    }
    let Ok(previous_at) = timestamp(&previous_sample.ts) else {
        return false;
    };
    let elapsed = i128::from(at) - i128::from(previous_at);
    if elapsed < 0 || elapsed >= i128::from(UNCHANGED_SAMPLE_MIN_MS) {
        return false;
    }
    for (old, new) in previous_sample.windows.iter().zip(&info.quota_windows) {
        if new.history_key.as_deref() != Some(old.key.as_str())
            || new.window.as_deref().unwrap_or("额度窗口") != old.label.as_str()
            || new.used_percent != Some(old.used_percent)
            || new.resets_at.as_deref() != old.resets_at.as_deref()
            || new.window_seconds != old.window_seconds
        {
            return false;
        }
        let Some(key) = new.history_key.as_deref().filter(|s| !s.is_empty()) else {
            return false;
        };
        let Some(used) = new.used_percent.filter(|p| p.is_finite() && *p >= 0.0) else {
            return false;
        };
        let Ok(reset) = new.resets_at.as_deref().map(timestamp).transpose() else {
            return false;
        };
        let tracker_key = format!("{:x}", Sha256::digest(format!("{scope}\0{key}")));
        let Some(tracker) = file.trackers.get(&tracker_key) else {
            return false;
        };
        if boundary(tracker, at, reset, used, Some(previous_sample.ts.as_str())).is_some() {
            return false;
        }
    }
    true
}

fn append(
    file: &mut File,
    info: &AccountInfo,
    now_ms: i64,
    max_samples: usize,
) -> Result<bool, String> {
    let scope = info
        .quota_scope
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or("尚未识别订阅工作区，无法隔离历史；请重新登录或填写 ChatGPT Account ID")?;
    let at = timestamp(&info.fetched_at)?;
    let last = file.last_observed.clone();
    // A late concurrent response must not rewind a checkpoint or invent a reset.
    // Compare full RFC3339 precision, not milliseconds, for rapid consecutive refreshes.
    if let Some(last) = &last {
        let last_time = DateTime::parse_from_rfc3339(last).map_err(|_| "订阅历史时间格式无效")?;
        let time =
            DateTime::parse_from_rfc3339(&info.fetched_at).map_err(|_| "订阅历史时间格式无效")?;
        if time < last_time {
            return Ok(false);
        }
        if time == last_time {
            let same = file.samples.last().is_some_and(|sample| {
                sample.scope == scope
                    && sample.windows.len() == info.quota_windows.len()
                    && sample
                        .windows
                        .iter()
                        .zip(&info.quota_windows)
                        .all(|(old, new)| {
                            new.history_key.as_deref() == Some(old.key.as_str())
                                && new.used_percent == Some(old.used_percent)
                                && new.resets_at == old.resets_at
                        })
            });
            return if same {
                Ok(false)
            } else {
                Err("订阅历史出现同一时刻的不同响应，已有记录未覆盖".into())
            };
        }
    }
    if can_skip_unchanged(file, info, scope, at) {
        file.last_observed = Some(info.fetched_at.clone());
        return Ok(false);
    }
    // The high-water mark rejects late responses. Segment continuity instead follows
    // the last retained sample, so skipped identical responses do not invent a return.
    let previous_sample = file
        .samples
        .last()
        .map(|sample| sample.ts.clone())
        .or(last.clone());
    let mut keys = HashSet::new();
    let mut windows = Vec::new();
    for window in &info.quota_windows {
        let key = window
            .history_key
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or("订阅窗口缺少稳定标识，无法记录历史")?;
        if !keys.insert(key) {
            return Err("订阅窗口标识重复，已有历史未覆盖".into());
        }
        let used = window
            .used_percent
            .filter(|p| p.is_finite() && *p >= 0.0)
            .ok_or("订阅额度百分比无效")?;
        let reset = window.resets_at.as_deref().map(timestamp).transpose()?;
        let tracker_key = format!("{:x}", Sha256::digest(format!("{scope}\0{key}")));
        let previous = file.trackers.get(&tracker_key);
        let event = previous.and_then(|p| boundary(p, at, reset, used, previous_sample.as_deref()));
        let segment = previous
            .map(|p| {
                if event.is_some() {
                    p.segment.checked_add(1).ok_or("订阅历史分段编号溢出")
                } else {
                    Ok(p.segment)
                }
            })
            .transpose()?
            .unwrap_or(1);
        let anchor = match (previous.and_then(|p| p.reset_anchor_ms), reset) {
            (Some(old), Some(new))
                if (i128::from(old) - i128::from(new)).abs() <= i128::from(RESET_JITTER_MS) =>
            {
                Some(old)
            }
            (_, Some(new)) => Some(new),
            (old, None) => old,
        };
        let same_anchor = previous.is_some_and(|p| p.reset_anchor_ms == anchor);
        let deadline_expired = previous.is_some_and(|p| same_anchor && p.deadline_expired)
            || reset.or(anchor).is_some_and(|deadline| at >= deadline);
        file.trackers.insert(
            tracker_key,
            Tracker {
                last_seen: info.fetched_at.clone(),
                last_used: used,
                reset_anchor_ms: anchor,
                segment,
                deadline_expired,
            },
        );
        windows.push(QuotaPoint {
            key: key.into(),
            label: window.window.clone().unwrap_or_else(|| "额度窗口".into()),
            used_percent: used,
            resets_at: window.resets_at.clone(),
            window_seconds: window.window_seconds,
            segment,
            boundary: event,
        });
    }
    file.samples.push(QuotaSample {
        ts: info.fetched_at.clone(),
        scope: scope.into(),
        windows,
    });
    file.last_observed = Some(info.fetched_at.clone());
    let cutoff = now_ms - chrono::Duration::days(90).num_milliseconds();
    file.samples
        .retain(|sample| timestamp(&sample.ts).is_ok_and(|t| t >= cutoff));
    if file.samples.len() > max_samples {
        file.samples.drain(..file.samples.len() - max_samples);
    }
    Ok(true)
}

fn record_at(
    path: &Path,
    info: &AccountInfo,
    now_ms: i64,
    max_samples: usize,
) -> Result<(), String> {
    let _guard = LOCK.lock().map_err(|_| "订阅历史锁不可用")?;
    let mut file = load(path)?;
    let previous_observed = file.last_observed.clone();
    if append(&mut file, info, now_ms, max_samples)? {
        let bytes = serde_json::to_vec(&file).map_err(|_| "序列化订阅历史失败")?;
        crate::config::write_bytes_atomic(path, &bytes)
            .map_err(|_| "保存订阅额度历史失败；查询结果仍可用，已有历史未覆盖".to_string())?;
    }
    if file.last_observed != previous_observed {
        let observed = file
            .last_observed
            .as_deref()
            .ok_or("订阅历史时间格式无效")?;
        crate::config::write_bytes_atomic(&cursor_path(path), observed.as_bytes())
            .map_err(|_| "保存订阅额度历史游标失败；查询结果仍可用".to_string())?;
    }
    Ok(())
}

pub async fn record(
    app: &tauri::AppHandle,
    account_id: &str,
    info: &AccountInfo,
) -> Result<(), String> {
    let app = app.clone();
    let account_id = account_id.to_owned();
    let info = info.clone();
    tokio::task::spawn_blocking(move || {
        record_at(
            &file_path(&app, &account_id)?,
            &info,
            Utc::now().timestamp_millis(),
            MAX_SAMPLES,
        )
    })
    .await
    .map_err(|_| "订阅历史记录任务失败".to_string())?
}

fn select_samples(
    file: File,
    scope: &str,
    since: Option<&str>,
) -> Result<Vec<QuotaSample>, String> {
    let since = since
        .map(|value| {
            DateTime::parse_from_rfc3339(value).map_err(|_| "订阅历史时间格式无效".to_string())
        })
        .transpose()?;
    Ok(file
        .samples
        .into_iter()
        .filter(|sample| {
            sample.scope == scope
                && since.as_ref().is_none_or(|since| {
                    DateTime::parse_from_rfc3339(&sample.ts)
                        .is_ok_and(|sample_at| sample_at > *since)
                })
        })
        .collect())
}

#[tauri::command]
pub async fn get_quota_history(
    app: tauri::AppHandle,
    account_id: String,
    scope: String,
    since: Option<String>,
) -> Result<Vec<QuotaSample>, String> {
    tokio::task::spawn_blocking(move || {
        let _guard = LOCK.lock().map_err(|_| "订阅历史锁不可用")?;
        let file = load(&file_path(&app, &account_id)?)?;
        select_samples(file, &scope, since.as_deref())
    })
    .await
    .map_err(|_| "订阅历史读取任务失败".to_string())?
}

#[cfg(test)]
#[path = "quota_history_tests.rs"]
mod tests;

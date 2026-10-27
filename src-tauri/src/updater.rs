use semver::Version;
use serde::Serialize;
use std::time::Duration;
use tauri::{Manager, ResourceId, Runtime, Webview};
use tauri_plugin_updater::UpdaterExt;
use url::Url;

const STABLE_ENDPOINT: &str =
    "https://github.com/Lingrui98/llm-status-board/releases/latest/download/latest.json";
const NIGHTLY_ENDPOINT: &str =
    "https://github.com/Lingrui98/llm-status-board/releases/download/nightly/latest.json";
const NIGHTLY_PRERELEASE_PREFIX: &str = "nightly.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UpdateChannel {
    Stable,
    Nightly,
}

impl UpdateChannel {
    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        match value {
            "stable" => Ok(Self::Stable),
            "nightly" => Ok(Self::Nightly),
            _ => Err(format!("更新渠道只支持 stable / nightly，当前为 {value:?}")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Nightly => "nightly",
        }
    }

    fn endpoint(self) -> &'static str {
        match self {
            Self::Stable => STABLE_ENDPOINT,
            Self::Nightly => NIGHTLY_ENDPOINT,
        }
    }

    fn from_version(version: &Version) -> Self {
        if version.pre.as_str().starts_with(NIGHTLY_PRERELEASE_PREFIX) {
            Self::Nightly
        } else {
            Self::Stable
        }
    }
}

/// 与 @tauri-apps/plugin-updater 的 Update 构造函数匹配的元数据。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateMetadata {
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
    rid: ResourceId,
}

fn is_update_available(
    current: &Version,
    remote: &Version,
    selected_channel: UpdateChannel,
) -> bool {
    if UpdateChannel::from_version(current) == selected_channel {
        remote > current
    } else {
        // 允许切换渠道，包括从 nightly 切回版本号更低的稳定版。
        remote != current
    }
}

#[tauri::command]
pub(crate) async fn check_channel_update<R: Runtime>(
    webview: Webview<R>,
    channel: String,
    proxy: Option<String>,
    timeout: Option<u64>,
) -> Result<Option<UpdateMetadata>, String> {
    let channel = UpdateChannel::parse(&channel)?;
    let endpoint = Url::parse(channel.endpoint())
        .map_err(|error| format!("更新端点无效（{}）: {error}", channel.as_str()))?;

    let mut builder = webview
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|error| format!("配置更新端点失败: {error}"))?
        .version_comparator(move |current, release| {
            is_update_available(&current, &release.version, channel)
        });

    if let Some(timeout) = timeout {
        builder = builder.timeout(Duration::from_millis(timeout));
    }
    if let Some(proxy) = proxy {
        let proxy = Url::parse(&proxy).map_err(|error| format!("更新代理地址无效: {error}"))?;
        builder = builder.proxy(proxy);
    }

    let updater = builder
        .build()
        .map_err(|error| format!("创建更新检查器失败: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("检查 {} 更新失败: {error}", channel.as_str()))?;

    let Some(update) = update else {
        return Ok(None);
    };

    let date = update
        .date
        .map(|date| date.format(&time::format_description::well_known::Rfc3339))
        .transpose()
        .map_err(|error| format!("格式化更新日期失败: {error}"))?;
    let metadata = UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date,
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    };
    Ok(Some(metadata))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn version(value: &str) -> Version {
        Version::parse(value).expect("测试版本必须是有效 semver")
    }

    #[test]
    fn channel_parser_and_endpoints_are_fixed() {
        assert_eq!(UpdateChannel::parse("stable"), Ok(UpdateChannel::Stable));
        assert_eq!(UpdateChannel::parse("nightly"), Ok(UpdateChannel::Nightly));
        for invalid in ["", "Stable", "beta", " nightly", "nightly "] {
            assert!(UpdateChannel::parse(invalid).is_err(), "应拒绝 {invalid:?}");
        }
        assert_eq!(UpdateChannel::Stable.endpoint(), STABLE_ENDPOINT);
        assert_eq!(UpdateChannel::Nightly.endpoint(), NIGHTLY_ENDPOINT);
    }

    #[test]
    fn nightly_channel_uses_nightly_prerelease_marker() {
        assert_eq!(
            UpdateChannel::from_version(&version("0.3.0-nightly.20261027")),
            UpdateChannel::Nightly
        );
        assert_eq!(
            UpdateChannel::from_version(&version("0.3.0-nightly.1+build.2")),
            UpdateChannel::Nightly
        );
        assert_eq!(
            UpdateChannel::from_version(&version("0.3.0")),
            UpdateChannel::Stable
        );
        assert_eq!(
            UpdateChannel::from_version(&version("0.3.0-beta.1")),
            UpdateChannel::Stable
        );
    }

    #[test]
    fn same_channel_requires_a_strictly_higher_semver() {
        let stable = version("0.2.11");
        assert!(is_update_available(
            &stable,
            &version("0.2.12"),
            UpdateChannel::Stable
        ));
        for remote in ["0.2.11", "0.2.10"] {
            assert!(!is_update_available(
                &stable,
                &version(remote),
                UpdateChannel::Stable
            ));
        }

        let nightly = version("0.3.0-nightly.20261027");
        assert!(is_update_available(
            &nightly,
            &version("0.3.0-nightly.20261028"),
            UpdateChannel::Nightly
        ));
        for remote in ["0.3.0-nightly.20261027", "0.3.0-nightly.20261026"] {
            assert!(!is_update_available(
                &nightly,
                &version(remote),
                UpdateChannel::Nightly
            ));
        }
    }

    #[test]
    fn different_channel_allows_a_different_remote_version() {
        assert!(
            is_update_available(
                &version("0.3.0-nightly.20261027"),
                &version("0.2.11"),
                UpdateChannel::Stable
            ),
            "nightly 必须能切回版本号更低的稳定版"
        );
        assert!(
            is_update_available(
                &version("0.2.11"),
                &version("0.2.11-nightly.20261027"),
                UpdateChannel::Nightly
            ),
            "稳定版必须能切到同核心版本的 nightly"
        );
        assert!(!is_update_available(
            &version("0.2.11"),
            &version("0.2.11"),
            UpdateChannel::Nightly
        ));
        assert!(!is_update_available(
            &version("0.2.11-nightly.1"),
            &version("0.2.11-nightly.1"),
            UpdateChannel::Stable
        ));
    }
}

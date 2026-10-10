pub mod custom;
pub mod modelserver;
pub mod official;
pub mod oneapi;
pub mod sub2api;

use crate::types::{AccountConfig, AccountInfo, ProviderKind};

pub async fn fetch_account(
    client: &reqwest::Client,
    acc: &AccountConfig,
) -> Result<AccountInfo, String> {
    match acc.kind {
        ProviderKind::OneApi | ProviderKind::NewApi => oneapi::fetch(client, acc).await,
        ProviderKind::Sub2Api => sub2api::fetch(client, acc).await,
        ProviderKind::ModelServer => modelserver::fetch(client, acc).await,
        ProviderKind::Custom => custom::fetch(client, acc).await,
        _ => official::fetch(client, acc).await,
    }
}

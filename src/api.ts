import { invoke } from "@tauri-apps/api/core";
import type { AccountConfig, AccountInfo, AppConfig, RefreshOutcome } from "./types";

export async function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return invoke("save_config", { config });
}

export async function testAccount(account: AccountConfig): Promise<AccountInfo> {
  return invoke<AccountInfo>("test_account", { account });
}

export async function refreshAll(): Promise<RefreshOutcome[]> {
  return invoke<RefreshOutcome[]>("refresh_all");
}

export async function configPath(): Promise<string> {
  return invoke<string>("config_path");
}

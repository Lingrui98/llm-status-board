import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
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

/// 导出配置：弹保存对话框 → 返回所选路径（用户取消返回 null）
export async function pickExportPath(): Promise<string | null> {
  return save({
    title: "导出配置（包含 API Key，请妥善保管文件）",
    defaultPath: "llm-status-board-config.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
}

export async function exportConfig(path: string): Promise<void> {
  return invoke("export_config", { path });
}

/// 导入配置：弹打开对话框 → 导入并返回合并后的配置（取消返回 null）
export async function pickImportPath(): Promise<string | null> {
  const picked = await open({
    title: "选择要导入的配置文件",
    multiple: false,
    directory: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  return typeof picked === "string" ? picked : null;
}

export async function importConfig(path: string): Promise<AppConfig> {
  return invoke<AppConfig>("import_config", { path });
}

/// 原生确认框（macOS WKWebView 的 window.confirm 不弹窗，必须用插件实现）
export async function confirmDialog(message: string): Promise<boolean> {
  return confirm(message, { title: "确认", kind: "warning" });
}

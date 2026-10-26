import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import type {
  AccountConfig,
  AccountInfo,
  AppConfig,
  BalanceSnapshot,
  RefreshOutcome,
  UsageHistoryFile,
  UsageRecord,
  QuotaSample,
} from "./types";

export async function getConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_config");
}

export async function saveConfig(config: AppConfig): Promise<void> {
  return invoke("save_config", { config });
}

export async function testAccount(account: AccountConfig): Promise<AccountInfo> {
  return invoke<AccountInfo>("test_account", { account });
}

/** 仅选择路径，凭据由本机后端在每次查询时读取，不把文件内容送入前端。 */
export async function pickCodexAuthFile(): Promise<string | null> {
  return open({ title: "选择 Codex 登录文件 auth.json", multiple: false, directory: false,
    filters: [{ name: "JSON", extensions: ["json"] }] });
}

export interface ChatgptLoginStart { attemptId: string; authUrl: string }
export type ChatgptLoginStatus = { status: "pending" } |
  { status: "complete"; authId: string; accountId: string | null } |
  { status: "failed"; message: string };
export const startChatgptLogin = () => invoke<ChatgptLoginStart>("start_chatgpt_login");
export const openChatgptLogin = (attemptId: string) => invoke<void>("open_chatgpt_login", { attemptId });
export const chatgptLoginStatus = (attemptId: string) => invoke<ChatgptLoginStatus>("chatgpt_login_status", { attemptId });
export const cancelChatgptLogin = (attemptId: string) => invoke<void>("cancel_chatgpt_login", { attemptId });
export const discardChatgptAuth = (authId: string) => invoke<void>("discard_chatgpt_auth", { authId });

export async function refreshAll(): Promise<RefreshOutcome[]> {
  return invoke<RefreshOutcome[]>("refresh_all");
}

/// 上次刷新结果（持久化在本地，重启后加载展示）
export async function getLastResults(): Promise<RefreshOutcome[]> {
  return invoke<RefreshOutcome[]>("get_last_results");
}

/// 余额历史快照（趋势图数据源）
export async function getHistory(): Promise<BalanceSnapshot[]> {
  return invoke<BalanceSnapshot[]>("get_history");
}

export const getQuotaHistory = (accountId: string, scope: string) =>
  invoke<QuotaSample[]>("get_quota_history", { accountId, scope });

/// R15 本地用量历史（逐日总账，带版本封套）；文件缺失时后端返回空记录集
export async function getUsageHistory(): Promise<UsageHistoryFile> {
  return invoke<UsageHistoryFile>("get_usage_history");
}

/// R15 写入用量历史批次（Rust 侧负责 site>local 合并、清理与幂等），返回合并后的总条数
export async function upsertUsageHistory(records: UsageRecord[]): Promise<number> {
  return invoke<number>("upsert_usage_history", { records });
}

/// R14 用量报表：弹保存对话框选 CSV 路径（用户取消返回 null）
export async function pickCsvExportPath(defaultName: string): Promise<string | null> {
  return save({
    title: "导出用量报表（CSV）",
    defaultPath: defaultName,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
}

/// R14 用量报表：写盘（Rust 侧原子写入；内容含 UTF-8 BOM 与 RFC 4180 转义，均在前端生成）
export async function exportCsv(path: string, content: string): Promise<void> {
  return invoke("export_csv", { path, content });
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

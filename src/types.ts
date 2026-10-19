// 与 Rust 侧 serde 序列化结构一一对应（camelCase）

export type ProviderKind =
  | "oneApi"
  | "newApi"
  | "sub2Api"
  | "modelServer"
  | "aiHubMix"
  | "deepSeek"
  | "openAi"
  | "siliconFlow"
  | "moonshot"
  | "zhipu"
  | "dashScope"
  | "custom";

export const PROVIDER_KINDS: { value: ProviderKind; label: string; group: string }[] = [
  { value: "oneApi", label: "one-api 系中转", group: "中转站" },
  { value: "newApi", label: "new-api 系中转", group: "中转站" },
  { value: "sub2Api", label: "sub2api 系中转", group: "中转站" },
  { value: "modelServer", label: "ModelServer（ETOChat/自建面板）", group: "中转站" },
  { value: "aiHubMix", label: "AiHubMix", group: "中转站" },
  { value: "custom", label: "自定义 HTTP 查询", group: "中转站" },
  { value: "deepSeek", label: "DeepSeek 官方", group: "官方" },
  { value: "openAi", label: "OpenAI 官方", group: "官方" },
  { value: "siliconFlow", label: "硅基流动 SiliconFlow", group: "官方" },
  { value: "moonshot", label: "月之暗面 Kimi/Moonshot", group: "官方" },
  { value: "zhipu", label: "智谱 GLM", group: "官方" },
  { value: "dashScope", label: "阿里云百炼 DashScope", group: "官方" },
];

export interface KeyValue {
  key: string;
  value: string;
}

export interface CustomQuery {
  method: string; // GET | POST
  url: string;
  headers: KeyValue[];
  body?: string | null;
  balancePath?: string | null;
  usedPath?: string | null;
  totalPath?: string | null;
  currencyPath?: string | null;
  currency?: string | null;
  scale?: number | null;
  extraPaths: KeyValue[];
}

export interface AccountConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  enabled: boolean;
  baseUrl: string;
  apiKey: string;
  token: string;
  refreshToken?: string;
  userId?: number | null;
  username: string;
  password: string;
  quotaPerUnit?: number | null;
  custom?: CustomQuery | null;
}

export interface Settings {
  autoRefreshSec: number;
  refreshOnStart: boolean;
  proxy?: string | null;
  /** 关闭窗口时最小化到系统托盘；缺省（undefined/null）视为 true，与 Rust 端 Option<bool> 对应 */
  closeToTray?: boolean | null;
  /** R14：余额/配额提醒总开关；缺省（undefined/null）视为 true（旧配置兼容） */
  notifyEnabled?: boolean | null;
  /** R14：低余额提醒阈值（USD 及其他法币）；缺省视为 1 */
  notifyLowBalanceUsd?: number | null;
  /** R14：低余额提醒阈值（CNY）；缺省视为 7 */
  notifyLowBalanceCny?: number | null;
  /** R14：配额用量提醒线（0-100）；缺省视为 85 */
  notifyQuotaPercent?: number | null;
  /** R14：洞察统计窗口（天）；缺省视为 14 */
  insightWindowDays?: number | null;
  /* ---- R16 常驻与自动化 ---- */
  /** R16：系统通知总开关；缺省（undefined/null）视为 **false**（默认关闭，不对用户突然弹通知） */
  systemNotifications?: boolean | null;
  /** R16：刷新整轮失败时自动重试；缺省视为 true */
  refreshRetryEnabled?: boolean | null;
  /** R16：自动重试次数上限；缺省视为 1，合法区间 0–3 整数 */
  refreshRetryMax?: number | null;
}

export interface AppConfig {
  version: number;
  settings: Settings;
  accounts: AccountConfig[];
}

export interface Money {
  amount: number;
  currency: string;
}

/** 用量数据点（按日或按模型聚合） */
export interface UsagePoint {
  date?: string | null;
  model?: string | null;
  requests?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  tokens?: number | null;
  cost?: number | null;
  costUnit?: string | null;
  latencyMs?: number | null;
}

/** 配额窗口（5h / 7d / 月度等） */
export interface QuotaWindow {
  window?: string | null;
  usedPercent?: number | null;
  resetsAt?: string | null;
}

/** 余额历史快照（趋势图数据源） */
export interface BalanceSnapshot {
  ts: string;
  accountId: string;
  balance: number;
  currency: string;
}

/* ---------- R15：本地用量历史（usage-history.json，与 Rust 侧 serde camelCase 对应） ---------- */

/** 记录来源：站点接口（权威） / 本地估算（余额下降或 used 计数器差值） */
export type UsageSource = "site" | "local";

/**
 * 逐日用量总账的一行 —— 键为 (accountId, date)。
 * 只存「账号 × 本地日历日」维度，**不含模型维度**（模型维度唯一来源是 results.json#modelUsage）。
 */
export interface UsageRecord {
  accountId: string;
  /** 本地日历日 "YYYY-MM-DD" */
  date: string;
  /** 当日花费；站点未给则为 null（本地估算路径必有值） */
  cost: number | null;
  /** 归一币种（USD/CNY/CREDITS/UNKNOWN…），永不空串 */
  currency: string;
  requests: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  tokens: number | null;
  /** 仅本地 used 计数器路径使用（§1.2 B2），其余为 null */
  usedTotal: number | null;
  source: UsageSource;
  /** 写入时刻（本地 RFC3339 带偏移） */
  updatedAt: string;
}

/** usage-history.json 的带版本封套（便于将来迁移，不用裸数组） */
export interface UsageHistoryFile {
  version: number;
  records: UsageRecord[];
}

export interface AccountInfo {
  balance?: Money | null;
  used?: Money | null;
  total?: Money | null;
  requests?: number | null;
  note?: string | null;
  extras: KeyValue[];
  raw?: unknown;
  fetchedAt: string;
  /** provider 轮换出的新 token（sub2api/ModelServer 的一次性 refresh token） */
  newToken?: string | null;
  newRefreshToken?: string | null;
  /** 按日用量（统计图） */
  dailyUsage?: UsagePoint[] | null;
  /** 按模型用量（统计图） */
  modelUsage?: UsagePoint[] | null;
  /** 配额窗口（进度条） */
  quotaWindows?: QuotaWindow[] | null;
}

export interface RefreshOutcome {
  accountId: string;
  ok: boolean;
  info?: AccountInfo | null;
  error?: string | null;
}

export const DEFAULT_BASE_URLS: Record<ProviderKind, string> = {
  oneApi: "https://your-oneapi-site.com",
  newApi: "https://your-newapi-site.com",
  sub2Api: "https://your-sub2api-site.com",
  modelServer: "https://codeapi.cs.ac.cn",
  aiHubMix: "https://aihubmix.com",
  custom: "https://your-relay-site.com",
  deepSeek: "https://api.deepseek.com",
  openAi: "https://api.openai.com",
  siliconFlow: "https://api.siliconflow.cn",
  moonshot: "https://api.moonshot.cn",
  zhipu: "https://open.bigmodel.cn",
  dashScope: "https://dashscope.aliyuncs.com",
};

export function newAccountId(): string {
  return crypto.randomUUID();
}

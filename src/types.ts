// 与 Rust 侧 serde 序列化结构一一对应（camelCase）

import type { ThemeMode } from "./theme";

export type ProviderKind =
  | "oneApi"
  | "newApi"
  | "sub2Api"
  | "modelServer"
  | "aiHubMix"
  | "deepSeek"
  | "openAi"
  | "openAiSubscription"
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
  { value: "openAi", label: "OpenAI API 官方", group: "官方" },
  { value: "openAiSubscription", label: "OpenAI 订阅（Codex）", group: "官方" },
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
  codexAuthPath?: string | null;
  chatgptAccountId?: string | null;
  chatgptAuthId?: string | null;
  userId?: number | null;
  username: string;
  password: string;
  quotaPerUnit?: number | null;
  custom?: CustomQuery | null;
}

export type UpdateChannel = "stable" | "nightly";

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
  /* ---- R22 一键更新 ---- */
  /** R22：启动时自动检查更新（静默，只提示不下载）；缺省（undefined/null）视为 true */
  autoCheckUpdate?: boolean | null;
  /** 更新渠道；缺省（undefined/null）视为 stable */
  updateChannel?: UpdateChannel | null;
  /* ---- R23 托盘额度可视化 ---- */
  /** R23：限额窗口明细显示方式；缺省（undefined/null）视为 "percent"（原始数字 = "raw"） */
  quotaDetailDisplay?: "percent" | "raw" | null;
  /* ---- 主题 ---- */
  /** 主题模式；缺省视为 system */
  themeMode?: ThemeMode | null;
  /** 固定时间模式的浅色开始时间；24 小时制 HH:mm，缺省为 07:00 */
  themeLightTime?: string | null;
  /** 固定时间模式的深色开始时间；24 小时制 HH:mm，缺省为 19:00 */
  themeDarkTime?: string | null;
  /** 日出日落模式的纬度；缺省为 0，合法范围 -90–90 */
  themeLatitude?: number | null;
  /** 日出日落模式的经度；缺省为 0，合法范围 -180–180 */
  themeLongitude?: number | null;
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

/** 配额窗口（5h / 1d / 7d / 1m / 月度等） */
export interface QuotaWindow {
  window?: string | null;
  /** 已用百分比（0-100；R23 起数字限额转换保留真实值，可 >100 表示超限——钳制是显示层职责） */
  usedPercent?: number | null;
  /** 重置时间（ISO8601；未知为 null，不编造） */
  resetsAt?: string | null;
  /** R23：数字限额窗口的原始已用量（sub2api 1d/7d/1m；纯百分比窗口为 null） */
  usedAmount?: Money | null;
  /** R23：数字限额窗口的原始上限（limit>0 才产出窗口，故存在即正数） */
  limitAmount?: Money | null;
  historyKey?: string | null;
  windowSeconds?: number | null;
}

export type QuotaBoundary = "reset" | "scheduleChanged" | "usageDecreased" | "windowReturned" | "expired";
export interface QuotaHistoryPoint {
  key: string;
  label: string;
  usedPercent: number;
  resetsAt: string | null;
  windowSeconds: number | null;
  segment: number;
  boundary: QuotaBoundary | null;
}
export interface QuotaSample {
  ts: string;
  scope: string;
  windows: QuotaHistoryPoint[];
}

/** 余额与总额度历史快照（旧记录没有 total） */
export interface BalanceSnapshot {
  ts: string;
  accountId: string;
  balance: number;
  currency: string;
  total?: number | null;
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
  /** used 模式标识，与后端基准精确匹配，跨模式不复用旧计数器。 */
  usedModeSince?: string | null;
  source: UsageSource;
  /** 写入时刻（本地 RFC3339 带偏移） */
  updatedAt: string;
}

/** usage-history.json 的带版本封套（便于将来迁移，不用裸数组） */
export interface UsageHistoryFile {
  version: number;
  records: UsageRecord[];
  balanceCheckpoints?: { accountId: string; ts: string; balance: number | null; currency: string; usedModeSince?: string | null }[];
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
  quotaScope?: string | null;
  quotaHistoryError?: string | null;
}

export interface RefreshOutcome {
  accountId: string;
  ok: boolean;
  info?: AccountInfo | null;
  error?: string | null;
  /** 查询成功但本地历史保存失败，不影响当前余额展示。 */
  historyError?: string | null;
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
  openAiSubscription: "https://chatgpt.com",
  siliconFlow: "https://api.siliconflow.cn",
  moonshot: "https://api.moonshot.cn",
  zhipu: "https://open.bigmodel.cn",
  dashScope: "https://dashscope.aliyuncs.com",
};

export function newAccountId(): string {
  return crypto.randomUUID();
}

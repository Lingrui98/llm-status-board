// 与 Rust 侧 serde 序列化结构一一对应（camelCase）

export type ProviderKind =
  | "oneApi"
  | "newApi"
  | "sub2Api"
  | "modelServer"
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

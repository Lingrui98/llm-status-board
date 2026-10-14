import type { Money } from "./types";

/** 金额拆分为「数字 + 货币代码」两部分（卡片大数字排版用；与 formatMoney 同一份精度规则） */
export function formatMoneyParts(m?: Money | null): { num: string; currency: string } | null {
  if (!m) return null;
  const abs = Math.abs(m.amount);
  let digits = 2;
  if (abs > 0 && abs < 0.01) digits = 6;
  else if (abs < 1) digits = 4;
  const num = m.amount.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return { num, currency: m.currency };
}

export function formatMoney(m?: Money | null): string {
  const p = formatMoneyParts(m);
  if (!p) return "—";
  return `${p.num} ${p.currency}`;
}

export function formatNumber(n?: number | null): string {
  if (n === null || n === undefined) return "—";
  return n.toLocaleString("zh-CN");
}

export function formatTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString("zh-CN", { hour12: false });
}

/** 相对过去时间：刚刚 / N秒前 / N分钟前 / N小时前 / N天前（未来时间按“刚刚”处理，容忍时钟偏差） */
export function formatTimeAgo(iso?: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = Math.max(0, now - t);
  if (diff < 30_000) return "刚刚";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return `${Math.floor(diff / 86_400_000)}天前`;
}

/** 相对未来时间（如配额重置）：1分钟内 / N分钟后 / N小时后 / N天后；已过返回“已到期” */
export function formatTimeUntil(iso?: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return iso;
  const diff = t - now;
  if (diff <= 0) return "已到期";
  if (diff < 60_000) return "1分钟内";
  if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)}分钟后`;
  if (diff < 86_400_000) return `${Math.ceil(diff / 3_600_000)}小时后`;
  return `${Math.ceil(diff / 86_400_000)}天后`;
}

/** 紧凑数字（坐标轴用）：1.2万 / 3.4亿 */
export function formatCompact(n?: number | null): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1e8) return `${trim(n / 1e8)}亿`;
  if (abs >= 1e4) return `${trim(n / 1e4)}万`;
  if (abs >= 1000) return n.toLocaleString("zh-CN", { maximumFractionDigits: 0 });
  if (abs >= 1) return n.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  return n.toLocaleString("zh-CN", { maximumFractionDigits: 4 });
}

/** 刷新耗时：不足 1s 显示毫秒（320ms），否则保留一位小数的秒数（2.4s）；非法输入回退占位符 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** 通用小数格式化（花费等，精度自适应） */
export function formatDecimal(v: number): string {
  const abs = Math.abs(v);
  let digits = 2;
  if (abs > 0 && abs < 0.01) digits = 6;
  else if (abs < 1) digits = 4;
  return v.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function kindLabel(kind: string): string {
  const map: Record<string, string> = {
    oneApi: "one-api",
    newApi: "new-api",
    sub2Api: "sub2api",
    modelServer: "ModelServer",
    deepSeek: "DeepSeek",
    openAi: "OpenAI",
    siliconFlow: "SiliconFlow",
    moonshot: "Moonshot",
    zhipu: "智谱",
    dashScope: "百炼",
    custom: "自定义",
  };
  return map[kind] ?? kind;
}

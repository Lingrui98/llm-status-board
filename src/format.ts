import type { Money } from "./types";

export function formatMoney(m?: Money | null): string {
  if (!m) return "—";
  const abs = Math.abs(m.amount);
  let digits = 2;
  if (abs > 0 && abs < 0.01) digits = 6;
  else if (abs < 1) digits = 4;
  const num = m.amount.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return `${num} ${m.currency}`;
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

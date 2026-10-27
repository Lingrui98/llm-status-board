import { isValidDateKey, localDateKey } from "./usageHistory";

/**
 * 将提供商日期归一到用量历史使用的日历日，并拒绝非法日期。
 * 带 Z 或显式偏移的时间戳保留其自身时区的日历日，与 usageHistory 和报表一致。
 */
export function normalizeLocalDay(raw: string): string | null {
  const key = localDateKey(raw);
  return isValidDateKey(key) ? key : null;
}

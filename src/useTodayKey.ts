import { useCallback, useEffect, useState } from "react";
import { toLocalDateKey } from "./usageHistory";

/** 当前本机日历日。跨午夜、窗口聚焦和页面恢复可见时都会更新。 */
export function useTodayKey() {
  const [todayKey, setTodayKey] = useState(() => toLocalDateKey());
  const updateTodayKey = useCallback(() => setTodayKey(toLocalDateKey()), []);

  useEffect(() => {
    const timer = window.setInterval(updateTodayKey, 60_000);
    window.addEventListener("focus", updateTodayKey);
    document.addEventListener("visibilitychange", updateTodayKey);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", updateTodayKey);
      document.removeEventListener("visibilitychange", updateTodayKey);
    };
  }, [updateTodayKey]);

  return { todayKey, updateTodayKey };
}

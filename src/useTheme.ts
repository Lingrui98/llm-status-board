import { useEffect, useState } from "react";
import type { Settings } from "./types";
import { getSystemTheme, resolveThemeMode, type ResolvedTheme } from "./theme";

/**
 * 将主题设置应用到根元素。系统偏好变化时立即更新，定时模式每 30 秒复查一次。
 * 页面重新可见或窗口重新获得焦点时也会复查，避免休眠后停留在旧主题。
 */
export function useTheme(settings?: Settings | null): ResolvedTheme {
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(() => getSystemTheme());
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemTheme(media.matches ? "dark" : "light");
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    const update = () => setNow(new Date());
    const timer = window.setInterval(update, 30_000);
    window.addEventListener("focus", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  const resolved = resolveThemeMode(settings, now, systemTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  return resolved;
}

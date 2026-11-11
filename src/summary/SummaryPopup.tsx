// R18 托盘悬停「用量总结」浮层 —— 数据与交互容器。
// - 数据：只用既有 IPC（get_config / get_last_results / get_usage_history），不触网、不加依赖；
// - 交互：指针进入/离开 → set_summary_pointer_inside；Escape → hide_summary_popup；
//   顶层窗口失焦由 Rust 隐藏。WebView 内部 blur 不直接隐藏，避免原生缩放被中断；
//   账号行点击 → summary_open_account（后端显示并聚焦主窗口，内部 emit tray-open-account）→ 隐藏浮层；
// - 窗口由 Rust 常驻创建、show()/hide() 复用不销毁：重新获得焦点时重新拉取，避免陈旧数据。

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { startSummaryResize } from "./summaryResize";
import { getConfig, getLastResults, getUsageHistory } from "../api";
import { resolveQuotaDetailDisplay } from "../residentSettings";
import SummaryCard, { type SummaryStatus } from "./SummaryCard";
import { buildSummary, type SummaryData } from "./summaryData";
import { loadSummarySize, saveSummarySize } from "./summarySize";
import { hideSummaryPopup, setSummaryPointerInside, summaryOpenAccount } from "./ipc";
import { useTheme } from "../useTheme";
import type { Settings } from "../types";

/** 失败只影响本浮层交互：静默降级（错误已由界面文案兜底） */
function fireAndForget(p: Promise<unknown>): void {
  void p.catch(() => {});
}

export default function SummaryPopup() {
  const [status, setStatus] = useState<SummaryStatus>("loading");
  const [data, setData] = useState<SummaryData | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  useTheme(settings);

  const load = useCallback(async () => {
    try {
      const [config, outcomes, history] = await Promise.all([getConfig(), getLastResults(), getUsageHistory()]);
      setSettings(config.settings);
      const enabled = config.accounts.filter((a) => a.enabled);
      if (enabled.length === 0) {
        setData(null);
        setStatus("empty");
        return;
      }
      setData(
        buildSummary({
          accounts: config.accounts,
          outcomes: outcomes ?? [],
          historyRecords: history?.records ?? [],
          // R23：限额窗口明细显示方式（缺省 percent；浮层每次显示/轮询都重新读取，开关即时生效）
          quotaDisplay: resolveQuotaDetailDisplay(config.settings),
        }),
      );
      setStatus("ready");
    } catch {
      setData(null);
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 浮层窗口复用（隐藏不销毁）：重新显示/获得焦点/轮询时刷新，避免整场会话读同一份陈旧结果
  useEffect(() => {
    const onFocus = () => void load();
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    // Rust 侧 show() 不保证触发 focus（focus:false 取舍）→ 低频轮询兜底（本地 IPC，开销可忽略）
    const timer = window.setInterval(() => void load(), 45_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(timer);
    };
  }, [load]);

  // Escape 立即隐藏。失焦只由 Rust 的顶层窗口事件处理。
  // WebView 在原生缩放时可能触发内部 blur，不能把它当成离开浮层。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      fireAndForget(hideSummaryPopup());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const resizeCleanup = useRef<(() => void) | null>(null);
  const handlePointerEnter = useCallback(() => fireAndForget(setSummaryPointerInside(true)), []);
  const handlePointerLeave = useCallback(() => {
    // 捕获期间光标可以越过旧窗口边界，不能因此启动自动隐藏。
    if (!resizeCleanup.current) fireAndForget(setSummaryPointerInside(false));
  }, []);
  useEffect(() => () => resizeCleanup.current?.(), []);

  // R24：尺寸调整 —— 启动时恢复上次拖拽的尺寸；调整结束时持久化。
  // 动态 import + catch：非 Tauri 环境（jsdom 测试）插件调用失败时静默降级，不影响浮层主体。
  useEffect(() => {
    const s = loadSummarySize();
    if (!s) return;
    void import("@tauri-apps/api/window")
      .then((m) => m.getCurrentWindow().setSize(new m.LogicalSize(s.width, s.height)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    // DOM resize 发生在视口更新之后；原生 onResized 回调可能读到上一帧尺寸。
    const save = () => saveSummarySize(window.innerWidth, window.innerHeight);
    window.addEventListener("resize", save);
    return () => window.removeEventListener("resize", save);
  }, []);

  const handleStartResize = useCallback((event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || resizeCleanup.current) return;
    if (/Mac/i.test(navigator.platform)) {
      fireAndForget(setSummaryPointerInside(true));
      resizeCleanup.current = startSummaryResize(
        event.currentTarget,
        event,
        { width: window.innerWidth, height: window.innerHeight },
        async (size) => {
          const m = await import("@tauri-apps/api/window");
          await m.getCurrentWindow().setSize(new m.LogicalSize(size.width, size.height));
        },
        () => {
          resizeCleanup.current = null;
          // 恢复隐藏复查；Rust 会在光标仍位于浮层内时继续保留窗口。
          fireAndForget(setSummaryPointerInside(false));
        },
      );
    } else {
      void import("@tauri-apps/api/window")
        .then((m) => m.getCurrentWindow().startResizeDragging("SouthEast"))
        .catch((error) => console.warn("无法调整用量总结窗口大小", error));
    }
  }, []);

  const handleSelectAccount = useCallback(async (accountId: string) => {
    try {
      await summaryOpenAccount(accountId);
    } catch {
      // 非阻塞：打开失败也不能让浮层卡住
    }
    fireAndForget(hideSummaryPopup());
  }, []);

  return (
    <SummaryCard
      status={status}
      data={data}
      onSelectAccount={handleSelectAccount}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onStartResize={handleStartResize}
    />
  );
}

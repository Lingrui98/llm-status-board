// R18 托盘悬停「用量总结」浮层 —— 数据与交互容器。
// - 数据：只用既有 IPC（get_config / get_last_results / get_usage_history），不触网、不加依赖；
// - 交互：指针进入/离开 → set_summary_pointer_inside；Escape → hide_summary_popup；
//   顶层窗口失焦由 Rust 隐藏。WebView 内部 blur 不直接隐藏，避免原生缩放被中断；
//   账号行点击 → summary_open_account（后端显示并聚焦主窗口，内部 emit tray-open-account）→ 隐藏浮层；
// - 窗口由 Rust 常驻创建、show()/hide() 复用不销毁：重新获得焦点时重新拉取，避免陈旧数据。

import { useCallback, useEffect, useState } from "react";
import { getConfig, getLastResults, getUsageHistory } from "../api";
import { resolveQuotaDetailDisplay } from "../residentSettings";
import SummaryCard, { type SummaryStatus } from "./SummaryCard";
import { buildSummary, type SummaryData } from "./summaryData";
import { loadSummarySize, saveSummarySize } from "./summarySize";
import { hideSummaryPopup, setSummaryPointerInside, summaryOpenAccount } from "./ipc";

/** 失败只影响本浮层交互：静默降级（错误已由界面文案兜底） */
function fireAndForget(p: Promise<unknown>): void {
  void p.catch(() => {});
}

export default function SummaryPopup() {
  const [status, setStatus] = useState<SummaryStatus>("loading");
  const [data, setData] = useState<SummaryData | null>(null);

  const load = useCallback(async () => {
    try {
      const [config, outcomes, history] = await Promise.all([getConfig(), getLastResults(), getUsageHistory()]);
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

  const handlePointerEnter = useCallback(() => fireAndForget(setSummaryPointerInside(true)), []);
  const handlePointerLeave = useCallback(() => fireAndForget(setSummaryPointerInside(false)), []);

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
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void import("@tauri-apps/api/window")
      .then((m) =>
        // 拖拽调整过程中高频触发；写 localStorage 是同步小操作，开销可忽略
        m.getCurrentWindow().onResized(() => {
          saveSummarySize(window.innerWidth, window.innerHeight);
        }),
      )
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 右下角拖拽手柄 → 原生尺寸拖拽（无边框窗口的常规做法）
  const handleStartResize = useCallback(() => {
    void import("@tauri-apps/api/window")
      .then((m) => m.getCurrentWindow().startResizeDragging("SouthEast"))
      .catch(() => {});
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

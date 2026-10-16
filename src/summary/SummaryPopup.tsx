// R18 托盘悬停「用量总结」浮层 —— 数据与交互容器。
// - 数据：只用既有 IPC（get_config / get_last_results / get_usage_history），不触网、不加依赖；
// - 交互：指针进入/离开 → set_summary_pointer_inside；Escape / 窗口失焦 → hide_summary_popup；
//   账号行点击 → summary_open_account（后端显示并聚焦主窗口，内部 emit tray-open-account）→ 隐藏浮层；
// - 窗口由 Rust 常驻创建、show()/hide() 复用不销毁：重新获得焦点时重新拉取，避免陈旧数据。

import { useCallback, useEffect, useState } from "react";
import { getConfig, getLastResults, getUsageHistory } from "../api";
import SummaryCard, { type SummaryStatus } from "./SummaryCard";
import { buildSummary, type SummaryData } from "./summaryData";
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

  // Escape / 失焦 → 立即隐藏（§1「延迟 0」）
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      fireAndForget(hideSummaryPopup());
    };
    const onBlur = () => fireAndForget(hideSummaryPopup());
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const handlePointerEnter = useCallback(() => fireAndForget(setSummaryPointerInside(true)), []);
  const handlePointerLeave = useCallback(() => fireAndForget(setSummaryPointerInside(false)), []);

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
    />
  );
}

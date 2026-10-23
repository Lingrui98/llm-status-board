import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { emitRefreshSettled } from "./refreshEvents";
import Dashboard from "./components/Dashboard";
import SettingsView from "./components/SettingsView";
import CommandPalette from "./components/CommandPalette";
import WelcomeGuide from "./components/WelcomeGuide";
import HelpPanel from "./components/HelpPanel";
import NotificationCenter from "./components/NotificationCenter";
import { InlineNotice } from "./components/ui";
import type { FocusRequest } from "./components/ProviderCard";
import * as api from "./api";
import type { AppConfig, BalanceSnapshot, ProviderKind, RefreshOutcome, UsageRecord } from "./types";
import { formatDurationMs } from "./format";
import { mergeRotatedTokens } from "./configMerge";
import { buildUsageBatch, hasUsageChanges, toLocalDateKey } from "./usageHistory";
import { RefreshRetryController, isWholeRoundFailure } from "./refreshRetry";
import { isSystemNotifyEnabled, resolveRetrySettings } from "./residentSettings";
import {
  commitSystemNotify,
  emptySystemNotifyState,
  isSystemNotifyKind,
  loadSystemNotifyState,
  saveSystemNotifyState,
  shouldSendSystemNotification,
  type SystemNotifySource,
} from "./systemNotify";
import { querySystemNotifyPermission, sendSystemNotify } from "./systemNotifyApi";
import { toggleAutostart } from "./autostart";
import { pluginAutostart, pluginSystemNotify, pluginUpdater, queryAppVersion } from "./pluginRuntime";
import { updaterErrorMessage, type UpdateInfo, type UpdateState } from "./updater";
import {
  computeProblemNotifications,
  diffRecovered,
  filterActiveRecovered,
  filterAlertsDisabled,
  isAlertKind,
  isNotifyEnabled,
  loadReadMap,
  mergeRecovered,
  pruneReadMap,
  resolveNotifyThresholds,
  saveReadMap,
  type AppNotification,
  type NotificationReadMap,
} from "./notifications";

/** localStorage 键：新手引导已关闭标记（桌面 WebView 的 localStorage 持久） */
const GUIDE_DISMISSED_KEY = "lsb-guide-dismissed";

/** 把任意异常转成可读单行提示（Tauri 命令的 Err 通常是字符串） */
function readableError(e: unknown): string {
  if (typeof e === "string") return e.trim() || "未知错误";
  if (e instanceof Error && e.message.trim()) return e.message.trim();
  try {
    const s = String(e).trim();
    return s && s !== "[object Object]" ? s : "未知错误";
  } catch {
    return "未知错误";
  }
}

function readGuideDismissed(): boolean {
  try {
    return window.localStorage.getItem(GUIDE_DISMISSED_KEY) === "1";
  } catch {
    return false; // 存储不可用时每次都展示引导，不阻塞使用
  }
}

type View = "dashboard" | "settings";

/** 事件目标是否在文本输入类控件内（数字键等全局快捷键此时应让位） */
function isEditingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [statuses, setStatuses] = useState<Record<string, RefreshOutcome>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [refreshAnnouncement, setRefreshAnnouncement] = useState("");
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  // 本次刷新耗时（毫秒）：从 refreshing 起止时间戳推导，纯前端，不新增 IPC
  const [lastRefreshMs, setLastRefreshMs] = useState<number | null>(null);
  // 顶栏进度条可见性：刷新结束后短暂保留「完成态」供淡出动画播放，再卸载元素
  const [progressVisible, setProgressVisible] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<BalanceSnapshot[]>([]);
  // R15：本地用量历史（逐日总账）。读取/写入失败都只做轻量提示，绝不影响看板主流程。
  const [usageRecords, setUsageRecords] = useState<UsageRecord[]>([]);
  const [usageError, setUsageError] = useState<string | null>(null);
  // 「今日」本地日历日：整个分析视图共用同一份来源，避免多处 new Date() 造成口径漂移
  const [todayKey, setTodayKey] = useState(() => toLocalDateKey());
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  // 新手引导：accounts 为空 && 未跳过时自动出现；guideOpen 支持从帮助面板手动重开
  const [guideDismissed, setGuideDismissed] = useState(readGuideDismissed);
  const [guideOpen, setGuideOpen] = useState(false);
  const configRef = useRef<AppConfig | null>(null);
  // 「去设置并添加账号（预选类型）」请求：nonce 判重，SettingsView 消费后经 onAddRequestHandled 清除
  const [addRequest, setAddRequest] = useState<{ kind: ProviderKind; nonce: number } | null>(null);
  // 「跳转到账号」请求：nonce 判重，Dashboard 投递给匹配卡片后经 onFocusRequestHandled 清除
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const refreshingRef = useRef(false);
  // 刷新开始时间戳（performance.now 单调时钟，不受系统时间调整影响）
  const refreshStartRef = useRef<number | null>(null);

  // ---------- 自动保存（设置页任何变更立即乐观生效，防抖 400ms 落盘） ----------
  // persistedConfigRef：我们认知中磁盘上的配置（上次成功保存/加载的值），作为 token 轮换合并的基准快照
  // pendingSaveRef：防抖期间用户最新一次待保存的配置；savingRef：save_config IPC 是否进行中
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [saveError, setSaveError] = useState("");
  const persistedConfigRef = useRef<AppConfig | null>(null);
  const pendingSaveRef = useRef<AppConfig | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const savingRef = useRef(false);
  const savedFadeTimerRef = useRef<number | null>(null);

  // 通知中心：面板开关 + 已读映射（localStorage 持久化）+ 「已恢复」瞬时记录
  const [notifOpen, setNotifOpen] = useState(false);
  const [notifRead, setNotifRead] = useState<NotificationReadMap>(loadReadMap);
  const [recoveredNotes, setRecoveredNotes] = useState<AppNotification[]>([]);
  // 上一轮问题键集合（恢复检测比对基准；null = 首轮不算恢复）
  const prevProblemKeys = useRef<Set<string> | null>(null);

  /* ---- R16 常驻与自动化 ---- */
  // R21：不再有「暂停自动刷新」开关 —— 自动刷新的唯一控制点是 autoRefreshSec（0 = 关闭）
  // §2 开机自启：真值以系统为准（查询/切换中禁用开关）
  const [autostart, setAutostart] = useState<{ enabled: boolean; busy: boolean; error?: string | null }>({
    enabled: false,
    busy: false,
  });
  // §4 系统通知权限状态（打开设置页时查询，不请求）
  const [notifyPermission, setNotifyPermission] = useState<"granted" | "denied" | "unknown">("unknown");
  // §5 重试倒计时展示（逐秒更新 → 渲染时 live="off"，状态变化单独播报一次）
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; max: number; remainingSec: number } | null>(null);
  const [retryAnnouncement, setRetryAnnouncement] = useState("");
  // 系统通知抑制表（localStorage 持久化，运行态不进配置）
  const sysNotifyStateRef = useRef(loadSystemNotifyState());
  // 上一轮「系统通知类」问题键（§4 规则 1：只推新问题）
  const prevSystemProblemKeys = useRef<Set<string> | null>(null);
  // 只在用户「打开开关」时请求一次通知权限
  const notifyPermissionAsked = useRef(false);
  const retryCtrlRef = useRef<RefreshRetryController | null>(null);

  /* ---- R22 一键更新（docs/round-22-updater-plan.md §4.4） ---- */
  // 更新状态机：App 层持有，SettingsView 只读渲染 + 发起动作
  const [updateState, setUpdateState] = useState<UpdateState>({ kind: "idle" });
  // updateState 的 ref 镜像：install/relaunch 处理器里读最新值而不必列入依赖
  const updateStateRef = useRef<UpdateState>({ kind: "idle" });
  // 检查/下载进行中互斥（手动与静默检查共用同一把锁，避免并发请求）
  const updateBusyRef = useRef(false);
  // 运行时应用版本（tauri.conf.json 为唯一事实来源；jsdom 下查询失败留空串 → UI 回退常量）
  const [appVersion, setAppVersion] = useState("");
  /** 本轮刷新的 okCount（供 finally 判定整轮失败；catch 也能读到） */
  const roundOkCountRef = useRef(0);
  if (retryCtrlRef.current === null) {
    const ctrl = new RefreshRetryController();
    ctrl.onStateChange = () => {
      const info = ctrl.pendingInfo();
      setRetryInfo(info ? { attempt: info.attempt, max: info.max, remainingSec: info.remainingSec } : null);
    };
    retryCtrlRef.current = ctrl;
  }

  const clearFocusRequest = useCallback(() => setFocusRequest(null), []);
  const clearAddRequest = useCallback(() => setAddRequest(null), []);

  // 关闭引导并持久化标记（跳过 / 完成 / ESC 共用）
  const dismissGuide = useCallback(() => {
    try {
      window.localStorage.setItem(GUIDE_DISMISSED_KEY, "1");
    } catch {
      // 存储不可用时仅本次会话记住
    }
    setGuideDismissed(true);
    setGuideOpen(false);
  }, []);

  // 引导/空状态「添加账号」：关引导 → 切设置 → 下发预选类型
  const handleAddAccount = useCallback(
    (kind: ProviderKind) => {
      dismissGuide();
      setAddRequest({ kind, nonce: Date.now() });
      setView("settings");
    },
    [dismissGuide],
  );

  // 帮助面板「重新打开新手引导」
  const handleReopenGuide = useCallback(() => {
    setHelpOpen(false);
    setGuideOpen(true);
  }, []);

  // 「跳转到账号」共用入口（命令面板 / 通知中心 / 托盘菜单）：确保在看板视图后下发请求
  //（卡片抽屉由 ProviderCard 自己打开）
  const openAccountOnDashboard = useCallback((accountId: string) => {
    setFocusRequest({ accountId, nonce: Date.now() });
    setView("dashboard");
  }, []);

  // 余额历史快照（趋势图数据源）：失败静默，不影响主流程
  const loadHistory = useCallback(async () => {
    try {
      setHistory(await api.getHistory());
    } catch {
      // 历史读取失败不影响看板展示
    }
  }, []);

  /**
   * R15：读取本地用量历史。
   * 读取失败（文件损坏等）→ 只记录可读提示并让分析视图走占位，**不阻塞**看板。
   */
  const loadUsageHistory = useCallback(async () => {
    try {
      const file = await api.getUsageHistory();
      setUsageRecords(Array.isArray(file?.records) ? file.records : []);
      setUsageError(null);
    } catch (e) {
      setUsageRecords([]);
      setUsageError(`本地用量历史读取失败：${readableError(e)}`);
    }
  }, []);

  /**
   * R15：把本次刷新的结果算成批次并写入本地用量历史。
   * 硬要求（Lead）：历史写入失败**不得**影响刷新主流程与看板可用性 ——
   * 这里捕获所有异常，只设置一条可读提示；调用方（refresh）不会因此中断。
   */
  const persistUsageBatch = useCallback(
    async (outcomes: RefreshOutcome[], dayKey: string) => {
      try {
        // Rust 已在清理快照前提交 B1：必须读其最新结果，不能用刷新前的旧视图计算 B2。
        const file = await api.getUsageHistory();
        const existing = Array.isArray(file?.records) ? file.records : [];
        setUsageRecords(existing);
        const accountIds = (configRef.current?.accounts ?? []).filter((a) => a.enabled).map((a) => a.id);
        // D-2：日期用本地日历日 dayKey（todayKey），不再让 B2 从 toISOString() 里推导 UTC 日
        const batch = buildUsageBatch(
          outcomes,
          existing,
          accountIds,
          new Date().toISOString(),
          dayKey,
          new Map((file.balanceCheckpoints ?? []).filter((c) => c.usedModeSince).map((c) => [c.accountId, c.usedModeSince!])),
        );
        // 无变化则不写盘（幂等；与 Rust 侧的字节级幂等双保险）
        if (!hasUsageChanges(batch.records, existing)) {
          setUsageError(null);
          return;
        }
        await api.upsertUsageHistory(batch.records);
        // 需要合并结果时再读一次（Rust 侧是唯一合并点）
        const saved = await api.getUsageHistory();
        setUsageRecords(Array.isArray(saved?.records) ? saved.records : []);
        setUsageError(null);
      } catch (e) {
        // 仅轻量提示：刷新结果照常展示
        setUsageError(`本地用量历史写入失败（不影响看板）：${readableError(e)}`);
      }
    },
    [],
  );

  const loadConfig = useCallback(async () => {
    try {
      const c = await api.getConfig();
      configRef.current = c;
      persistedConfigRef.current = c;
      setConfig(c);
      setLoadError(null);
      return c;
    } catch (e) {
      setLoadError(String(e));
      return null;
    }
  }, []);

  /**
   * 刷新全部账号。
   * @param auto 是否由「自动重试」触发（true 时失败不再续接新的重试链）
   *
   * R16 §5：整轮失败（IPC 抛错，或启用账号数 > 0 且 okCount === 0）时安排退避重试；
   * `okCount > 0` 的部分失败不重试（避免放大请求量）。
   */
  const refresh = useCallback(async (auto = false) => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    refreshStartRef.current = performance.now();
    setRefreshing(true);
    // 本轮是否整轮失败：用 ref 让 catch 也能读到（抛错时保持默认 false 之外需显式判定）
    let ipcFailed = false;
    roundOkCountRef.current = 0;
    try {
      const outcomes = await api.refreshAll();
      const map: Record<string, RefreshOutcome> = {};
      for (const o of outcomes) map[o.accountId] = o;
      setStatuses(map);
      const enabledIds = new Set((configRef.current?.accounts ?? []).filter((a) => a.enabled).map((a) => a.id));
      const visibleOutcomes = outcomes.filter((o) => enabledIds.has(o.accountId));
      const okCount = visibleOutcomes.filter((o) => o.ok).length;
      roundOkCountRef.current = okCount;
      const failCount = visibleOutcomes.length - okCount;
      setRefreshAnnouncement(
        failCount > 0 ? `刷新完成，${okCount} 个账号正常，${failCount} 个异常` : `刷新完成，${okCount} 个账号正常`,
      );
      setLastRefreshAt(new Date().toISOString());
      // R15：刷新后「今天」重新取一次（跨零点刷新时窗口口径要跟着走），
      // 并把它同时用于余额历史与用量历史批次（单一来源，避免时区漂移）。
      const dayKey = toLocalDateKey();
      // 曲线历史与消费账本独立；不再用保留下来的点覆盖整日累计。
      const freshSnaps = await api.getHistory().catch(() => null);
      if (freshSnaps) {
        setHistory(freshSnaps);
      }
      const historyError = outcomes.find((o) => o.historyError)?.historyError;
      if (historyError) {
        setUsageError(`本地历史保存失败（查询结果仍可用）：${historyError}`);
      } else {
        await persistUsageBatch(outcomes, dayKey);
      }
      setTodayKey(dayKey);
    } catch (e) {
      ipcFailed = true;
      setLoadError(String(e));
    } finally {
      refreshingRef.current = false;
      // 耗时统计：成功与失败都记录（失败也是一次真实等待），与 IPC 逻辑解耦
      if (refreshStartRef.current !== null) {
        setLastRefreshMs(performance.now() - refreshStartRef.current);
        refreshStartRef.current = null;
      }
      setRefreshing(false);
      // R21：刷新结束（成功与失败都）通知 Rust —— 托盘菜单据此从「刷新中…」恢复、重载账号区。
      // 收口在 finally，保证多 return / 异常路径都恰好回报一次。
      emitRefreshSettled();

      // R16 §5：整轮失败 → 安排一次退避重试（启用账号数 > 0 且 okCount === 0，或 IPC 抛错）。
      // 自动重试自己触发的这轮失败不再续接（由下一次定时/手动刷新重新开始）。
      const enabledCount = (configRef.current?.accounts ?? []).filter((a) => a.enabled).length;
      const wholeFailed = isWholeRoundFailure({
        ipcFailed,
        enabledAccountCount: enabledCount,
        okCount: roundOkCountRef.current,
      });
      if (wholeFailed && !auto) {
        const ctrl = retryCtrlRef.current;
        // 非自动重试触发的整轮失败 = 新一轮（手动刷新或定时刷新）→ 把退避计数归零后重新安排
        if (ctrl && ctrl.attemptCount >= ctrl.maxRetries) ctrl.cancel();
        if (ctrl && ctrl.schedule()) {
          setRetryAnnouncement(`刷新失败，${ctrl.attemptCount}/${ctrl.maxRetries} 次重试已安排`);
        } else {
          // 未启用或已达上限 → 如实报失败（不改写 loadError，也不假装在重试）
          setRetryAnnouncement("");
        }
      } else if (!wholeFailed) {
        retryCtrlRef.current?.cancel();
        setRetryAnnouncement("");
      }
    }
  }, [loadHistory, persistUsageBatch]);

  // R16 §5：把配置同步进重试控制器（开关 / 次数上限）
  useEffect(() => {
    const { enabled, max } = resolveRetrySettings(config?.settings);
    const ctrl = retryCtrlRef.current;
    if (!ctrl) return;
    ctrl.enabled = enabled;
    ctrl.maxRetries = max;
    if (!enabled || max === 0) {
      ctrl.cancel();
      setRetryInfo(null);
      setRetryAnnouncement("");
    } else {
      ctrl.onStateChange?.(); // 上限变化后刷新展示信息
    }
  }, [config?.settings]);

  // R16 §5：到点触发重试。自动重试自己不再续接新的重试链（避免无限循环）。
  useEffect(() => {
    const ctrl = retryCtrlRef.current;
    if (!ctrl) return;
    ctrl.onFire = (attempt) => {
      setRetryAnnouncement(`第 ${attempt} 次重试中…`);
      void refresh(true);
    };
    return () => {
      ctrl.onFire = null;
    };
  }, [refresh]);

  // R16 §5：倒计时逐秒刷新（仅用于展示；渲染时用 live="off" 避免读屏每秒播报）
  useEffect(() => {
    if (!retryInfo) return;
    const timer = window.setInterval(() => retryCtrlRef.current?.onStateChange?.(), 500);
    return () => window.clearInterval(timer);
  }, [retryInfo]);

  // 组件卸载：清理重试定时器
  useEffect(() => {
    const ctrl = retryCtrlRef.current;
    return () => ctrl?.dispose();
  }, []);

  // R21：托盘「立即刷新」与主面板刷新是**同一个动作** —— Rust 在托盘菜单项上 emit `tray-refresh`，
  // 这里调用与顶栏 / 总览条 / 设置页 / 命令面板 / 各区块完全相同的 refresh()（不另建刷新路径）。
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      try {
        const u = await listen("tray-refresh", () => {
          void refresh();
        });
        if (disposed) u();
        else unlisten = u;
      } catch {
        // 无事件后端（jsdom）：忽略
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh]);

  // R16 §6：托盘「打开设置」→ 切到设置视图
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      try {
        const u = await listen("tray-open-settings", () => setView("settings"));
        if (disposed) u();
        else unlisten = u;
      } catch {
        // 无事件后端：忽略
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // R16 §2：进入设置页时查询自启真实状态（查询中禁用开关）；离开时清掉错误提示
  useEffect(() => {
    if (view !== "settings") return;
    let cancelled = false;
    setAutostart((s) => ({ ...s, busy: true }));
    (async () => {
      try {
        const on = await pluginAutostart.isEnabled();
        if (!cancelled) setAutostart({ enabled: on, busy: false, error: null });
      } catch (e) {
        if (!cancelled) setAutostart((s) => ({ ...s, busy: false, error: readableError(e) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view]);

  // R16 §4：进入设置页时查询通知权限（**不**请求权限）
  useEffect(() => {
    if (view !== "settings") return;
    let cancelled = false;
    (async () => {
      const p = await querySystemNotifyPermission(pluginSystemNotify);
      if (!cancelled) setNotifyPermission(p);
    })();
    return () => {
      cancelled = true;
    };
  }, [view, config?.settings.systemNotifications]);

  /* ---- R22 一键更新（docs/round-22-updater-plan.md §4.4） ---- */

  // 静默检查发现新版本时的系统通知：尊重系统通知总开关；同一版本只推一次（localStorage 去重）；
  // 后台检查**绝不**主动请求权限（allowRequest=false）
  const maybeNotifyUpdate = useCallback((info: UpdateInfo) => {
    if (!isSystemNotifyEnabled(configRef.current?.settings)) return;
    const key = `lsb-update-notified:${info.version}`;
    try {
      if (window.localStorage.getItem(key) === "1") return;
      window.localStorage.setItem(key, "1");
    } catch {
      // 存储不可用：照常尝试发送（sendSystemNotify 自身有失败降级）
    }
    void sendSystemNotify(
      pluginSystemNotify,
      {
        title: "LLM Status Board 有新版本",
        body: `v${info.version} 已发布，前往「设置 → 关于与更新」一键更新。`,
      },
      false,
    );
  }, []);

  /**
   * 检查更新（手动 / 启动静默共用同一把 busy 锁）。
   * silent=true：已最新与失败都回落 idle，不在 UI 留痕（只有「发现新版本」才提示）。
   */
  const runUpdateCheck = useCallback(
    async (silent: boolean) => {
      if (updateBusyRef.current) return;
      updateBusyRef.current = true;
      setUpdateState({ kind: "checking" });
      try {
        const info = await pluginUpdater.check(configRef.current?.settings.proxy ?? null);
        if (!info) {
          setUpdateState(silent ? { kind: "idle" } : { kind: "up-to-date" });
          return;
        }
        setUpdateState({ kind: "available", info });
        if (silent) maybeNotifyUpdate(info);
      } catch (e) {
        setUpdateState(
          silent ? { kind: "idle" } : { kind: "error", phase: "check", message: updaterErrorMessage(e, "check") },
        );
      } finally {
        updateBusyRef.current = false;
      }
    },
    [maybeNotifyUpdate],
  );

  const handleCheckUpdate = useCallback(() => {
    void runUpdateCheck(false);
  }, [runUpdateCheck]);

  // 一键更新：available → downloading(进度回调) → ready（macOS 待重启；Windows 多半已被 NSIS 接管重启，
  // downloadAndInstall 不再返回——所以「成功」推进写在 await 之后是安全的，执行不到也无副作用）
  const handleInstallUpdate = useCallback(async () => {
    const cur = updateStateRef.current;
    if (cur.kind !== "available" || updateBusyRef.current) return;
    updateBusyRef.current = true;
    setUpdateState({ kind: "downloading", info: cur.info, received: 0, total: null });
    try {
      await pluginUpdater.downloadAndInstall((received, total) => {
        setUpdateState((s) => (s.kind === "downloading" ? { ...s, received, total } : s));
      });
      setUpdateState({ kind: "ready", info: cur.info });
    } catch (e) {
      setUpdateState({ kind: "error", phase: "install", message: updaterErrorMessage(e, "install") });
    } finally {
      updateBusyRef.current = false;
    }
  }, []);

  // 安装完成后重启进新版；失败如实告知 + 手动重启指引（绝不假装已重启）
  const handleRelaunchAfterUpdate = useCallback(async () => {
    try {
      await pluginUpdater.relaunch();
    } catch (e) {
      setUpdateState({
        kind: "error",
        phase: "install",
        message: `重启失败：${readableError(e)}；请手动关闭应用后重新打开`,
      });
    }
  }, []);

  // 兜底：系统浏览器打开发布页（capability 已把 open 限定在本仓库 releases；失败如实提示）
  const handleOpenReleasePage = useCallback(async () => {
    try {
      await pluginUpdater.openReleasePage();
    } catch (e) {
      setUpdateState({
        kind: "error",
        phase: "check",
        message: `无法打开发布页：${readableError(e)}；请手动访问 github.com/Lingrui98/llm-status-board/releases`,
      });
    }
  }, []);

  // updateState → ref 镜像（install/relaunch 处理器读最新值而不必列入依赖）
  useEffect(() => {
    updateStateRef.current = updateState;
  }, [updateState]);

  // 运行时版本号（设置页 / 帮助面板展示；jsdom 查询失败留空串 → 组件回退到打包期常量）
  useEffect(() => {
    let cancelled = false;
    void queryAppVersion().then((v) => {
      if (!cancelled && v) setAppVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 启动约 5s 后静默检查一次更新（默认开，可在「设置 → 关于与更新」关闭；只提示，不自动下载）
  useEffect(() => {
    const t = window.setTimeout(() => {
      if ((configRef.current?.settings.autoCheckUpdate ?? true) === false) return;
      void runUpdateCheck(true);
    }, 5000);
    return () => window.clearTimeout(t);
  }, [runUpdateCheck]);

  // 初始化：加载配置 → 按设置决定是否自动刷新一次
  useEffect(() => {
    (async () => {
      const c = await loadConfig();
      // 先加载上次结果（立即可见的旧数据），再决定是否自动刷新
      try {
        const last = await api.getLastResults();
        if (last.length > 0 && c) {
          // 只保留当前配置里仍存在的账号，避免展示已删除账号的旧数据
          const ids = new Set(c.accounts.filter((a) => a.enabled).map((a) => a.id));
          const map: Record<string, RefreshOutcome> = {};
          for (const o of last) {
            if (ids.has(o.accountId)) map[o.accountId] = o;
          }
          setStatuses(map);
        }
      } catch {
        // 上次结果读取失败不影响启动
      }
      // 拉取余额历史（供卡片内趋势图使用）
      await loadHistory();
      // R15：拉取本地用量历史（分析视图数据源）。失败只记录提示，不影响启动。
      await loadUsageHistory();
      if (c && c.settings.refreshOnStart && c.accounts.some((a) => a.enabled)) {
        refresh();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动刷新定时器（R21：唯一控制点是 autoRefreshSec；0 = 关闭，不再有暂停态短路）
  useEffect(() => {
    if (refreshTimer.current) {
      window.clearInterval(refreshTimer.current);
      refreshTimer.current = null;
    }
    const sec = config?.settings.autoRefreshSec ?? 0;
    if (sec > 0) {
      refreshTimer.current = window.setInterval(() => {
        void refresh();
      }, sec * 1000);
    }
    return () => {
      if (refreshTimer.current) window.clearInterval(refreshTimer.current);
    };
  }, [config?.settings.autoRefreshSec, refresh]);

  // 全局快捷键：Ctrl/Cmd+K 与 Ctrl+P 切换命令面板；数字键 1-9 打开第 N 个启用账号详情
  //（仅看板视图、面板未开、焦点不在输入控件时；Tauri WebView 下 Ctrl/Meta 都能收到）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K" || e.key === "p" || e.key === "P")) {
        e.preventDefault(); // 挡住浏览器默认行为（打印 / 地址栏搜索）
        setPaletteOpen((v) => !v);
        return;
      }
      if (
        view === "dashboard" &&
        !paletteOpen &&
        /^[1-9]$/.test(e.key) &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !isEditingTarget(e.target)
      ) {
        const acc = config?.accounts.filter((a) => a.enabled)[Number(e.key) - 1];
        if (acc) setFocusRequest({ accountId: acc.id, nonce: Date.now() });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, paletteOpen, config]);

  // 把 pendingSaveRef 里的最新配置落盘（串行执行；token 轮换合并语义与原「保存全部」一致，
  // 但基准用 persistedConfigRef（上次持久化值）而非 UI 态——乐观更新下 UI 态已是新值，不能作基准）
  const flushSave = useCallback(async () => {
    if (savingRef.current) return; // 上一次保存还在进行，结束后由 finally 接力
    const next = pendingSaveRef.current;
    if (!next || next === persistedConfigRef.current) return;
    savingRef.current = true;
    pendingSaveRef.current = null;
    if (savedFadeTimerRef.current) {
      window.clearTimeout(savedFadeTimerRef.current);
      savedFadeTimerRef.current = null;
    }
    setSaveState("saving");
    try {
      let toSave = next;
      try {
        // 每次落盘前重新拉磁盘最新配置做合并：refresh_all 刚轮换的 token 不会被旧值覆盖
        const disk = await api.getConfig();
        toSave = mergeRotatedTokens(next, persistedConfigRef.current, disk);
      } catch {
        // 磁盘读取失败就用用户输入的
      }
      // 代理地址仅落盘时修剪空白（输入过程保留原样，不打断键入）
      toSave = { ...toSave, settings: { ...toSave.settings, proxy: toSave.settings.proxy?.trim() || null } };
      await api.saveConfig(toSave);
      persistedConfigRef.current = toSave;
      // 保存期间用户没有新编辑：把合并结果（可能含轮换后的新 token）同步进 UI 态；
      // 有新编辑则不动 UI（用户的更新版本已在 pending/后续 flush 中处理）
      if (configRef.current === next) {
        configRef.current = toSave;
        setConfig(toSave);
      }
      setSaveState("saved");
      // 「已自动保存」短暂浮现后淡回 idle
      savedFadeTimerRef.current = window.setTimeout(() => {
        setSaveState((s) => (s === "saved" ? "idle" : s));
        savedFadeTimerRef.current = null;
      }, 2200);
    } catch (e) {
      setSaveError(String(e));
      setSaveState("error");
    } finally {
      savingRef.current = false;
      // 保存期间又有新变更：短延迟后接力落盘
      if (pendingSaveRef.current && pendingSaveRef.current !== persistedConfigRef.current) {
        saveTimerRef.current = window.setTimeout(() => {
          saveTimerRef.current = null;
          void flushSave();
        }, 150);
      }
    }
  }, []);

  // 设置页统一入口：任何变更立即乐观生效（看板/快捷键/命令面板同步看到），400ms 防抖后落盘
  const handleSaveSettings = useCallback(
    (newConfig: AppConfig) => {
      configRef.current = newConfig;
      setConfig(newConfig);
      pendingSaveRef.current = newConfig;
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null;
        void flushSave();
      }, 400);
    },
    [flushSave],
  );

  // 立即落盘（设置页「刷新数据」前先保证磁盘是最新配置；保存失败重试也走这里）
  const flushSaveNow = useCallback(async () => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await flushSave();
  }, [flushSave]);

  const handleRetrySave = useCallback(() => {
    // 失败时 pending 已被消费，用当前 UI 配置重试（用户看到的就是要保存的）
    if (configRef.current) pendingSaveRef.current = configRef.current;
    void flushSaveNow();
  }, [flushSaveNow]);

  // 设置页「刷新数据」：先把待保存的变更落盘，再用最新配置刷新
  const handleSettingsRefresh = useCallback(async () => {
    await flushSaveNow();
    await refresh();
  }, [flushSaveNow, refresh]);

  // 卸载时清理自动保存定时器
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (savedFadeTimerRef.current) window.clearTimeout(savedFadeTimerRef.current);
    };
  }, []);

  // ---------- 通知推导（纯前端，从 refresh / get_last_results 的结果计算，不动 IPC 逻辑） ----------

  // 启用账号的 id → 显示名（同时充当 statuses 的白名单过滤：只看当前可见账号）
  const accountNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of config?.accounts ?? []) if (a.enabled) m[a.id] = a.name;
    return m;
  }, [config]);

  const visibleOutcomes = useMemo(
    () => Object.values(statuses).filter((o) => accountNames[o.accountId] !== undefined),
    [statuses, accountNames],
  );

  // 问题类通知（余额不足 / 刷新失败 / 配额将满）+ 当前问题键集合。
  // R14：阈值从配置派生（旧配置缺字段 → 默认值）；总开关关闭时只丢弃提醒类，刷新失败保留。
  const problemResult = useMemo(() => {
    const result = computeProblemNotifications(
      visibleOutcomes,
      accountNames,
      resolveNotifyThresholds(config?.settings),
      lastRefreshAt ?? undefined,
    );
    return isNotifyEnabled(config?.settings) ? result : filterAlertsDisabled(result);
  }, [visibleOutcomes, accountNames, lastRefreshAt, config?.settings]);

  // 恢复检测：上轮有、本轮消失且账号本轮刷新成功 → 追加一条「已恢复」（首轮不比）
  // R14 终审 D-3：关闭提醒总开关时，提醒类问题键会从本轮集合里被清掉，
  // 若照常比对就会凭空产生「已恢复」通知（其实只是用户关了开关）。这里用 shouldRecover
  // 把提醒类排除在恢复检测之外 —— 这是 D-3 的**唯一修复点**，其余逻辑保持不变。
  const alertsEnabled = isNotifyEnabled(config?.settings);
  useEffect(() => {
    const prev = prevProblemKeys.current;
    const cur = problemResult.problemKeys;
    if (prev !== null) {
      const okIds = new Set(visibleOutcomes.filter((o) => o.ok).map((o) => o.accountId));
      const newly = diffRecovered(prev, cur, okIds, accountNames, undefined, (kind) =>
        alertsEnabled || !isAlertKind(kind),
      );
      if (newly.length > 0) setRecoveredNotes((rs) => mergeRecovered(rs, newly));
    }
    prevProblemKeys.current = cur;
  }, [problemResult, visibleOutcomes, accountNames, alertsEnabled]);

  // 可见通知 = 当前问题 + 仍有效的恢复（问题复发时对应恢复记录被剔除），按时间倒序
  const notifications = useMemo(() => {
    const active = filterActiveRecovered(recoveredNotes, problemResult.problemKeys);
    return [...problemResult.notifications, ...active].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }, [problemResult, recoveredNotes]);

  /**
   * R16 §4 系统通知派发。
   * 三条防打扰规则全部由纯函数 `shouldSendSystemNotification` 判定（见 systemNotify.ts）：
   *   ① 只推新问题（与上一轮快照比对）② 24h 抑制 ③ 5 分钟内最多 3 条。
   * 开关关闭 / 权限被拒 / 发送失败一律静默降级为应用内通知，**绝不影响刷新主流程**。
   */
  useEffect(() => {
    const settings = config?.settings;
    if (!isSystemNotifyEnabled(settings)) {
      // 关闭时不请求权限、不发送；但仍记录快照，避免重新打开时把"旧问题"误判为新问题
      prevSystemProblemKeys.current = new Set(
        [...problemResult.problemKeys].filter((k) => isSystemNotifyKind(k.split(":")[0])),
      );
      return;
    }

    const isSystemKey = (k: string) => isSystemNotifyKind(k.split(":")[0]);
    const activeKeys = [...problemResult.problemKeys].filter(isSystemKey);
    const prev = prevSystemProblemKeys.current;
    const newKeys = activeKeys.filter((k) => !prev?.has(k));

    if (newKeys.length > 0) {
      // 本轮同意请求权限：仅在用户刚打开开关时（每次开启最多一次）
      const allowRequest = !notifyPermissionAsked.current;
      const byKey = new Map(problemResult.notifications.map((n) => [n.id, n]));
      const sources: SystemNotifySource[] = newKeys
        .map((k) => byKey.get(k))
        .filter((n): n is NonNullable<typeof n> => !!n)
        .map((n) => ({
          kind: n.kind,
          accountId: n.accountId,
          accountName: n.accountName,
          detail: n.detail ?? n.title,
          active: true,
        }));

      void (async () => {
        let state = sysNotifyStateRef.current;
        let permissionNow = notifyPermission;
        for (const src of sources) {
          const decision = shouldSendSystemNotification(src, {
            now: Date.now(),
            enabled: true,
            state,
            // 新问题判定已在上方用快照完成，这里传空集让纯函数只做 24h 与速率判定
            prevProblemKeys: new Set<string>(),
          });
          if (!decision.send) continue;
          const res = await sendSystemNotify(
            pluginSystemNotify,
            { title: decision.title, body: decision.body },
            allowRequest,
          );
          if (allowRequest) notifyPermissionAsked.current = true;
          if (res.permission !== permissionNow) {
            permissionNow = res.permission;
            setNotifyPermission(res.permission);
          }
          if (res.sent) {
            // 只有真正发出去才记账：被规则丢弃的通知不写抑制表、不计入速率（§4 规则 3）
            state = commitSystemNotify(state, decision.key, Date.now());
            sysNotifyStateRef.current = state;
            saveSystemNotifyState(state);
          } else if (res.skipped === "notGranted") {
            break; // 未授权：本条及后续都不必再试（不反复骚扰）
          }
        }
      })();
    }

    prevSystemProblemKeys.current = new Set(activeKeys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemResult, config?.settings]);

  /** R16 §2：切换开机自启 —— 命令成功后**再次查询**确认真实状态；失败回滚并给可读原因 */
  const handleToggleAutostart = useCallback(async (next: boolean) => {
    setAutostart((s) => ({ ...s, busy: true, error: null }));
    const api2 = pluginAutostart;
    const res = await toggleAutostart(api2, next);
    setAutostart({ enabled: res.enabled, busy: false, error: res.ok ? null : (res.error ?? "开机自启设置失败") });
  }, []);

  /**
   * R16 §4：用户点「重新请求授权」→ 再请求一次通知权限。
   * 契约诚实性（task-27）：插件**没有**打开系统设置页的能力，本函数只做「重新请求」，
   * 不谎称能跳转系统设置；手动放行路径由设置页提示正文告知用户。
   */
  const handleRequestNotifyPermission = useCallback(async () => {
    notifyPermissionAsked.current = true;
    const res = await sendSystemNotify(
      pluginSystemNotify,
      { title: "LLM Status Board", body: "通知已开启" },
      true,
    );
    setNotifyPermission(res.permission);
  }, []);

  const unreadCount = notifications.reduce((n, x) => n + (notifRead[x.id] ? 0 : 1), 0);
  const hasUnreadError = notifications.some((x) => !notifRead[x.id] && x.severity === "err");

  // 已读写入：合并 → 修剪到当前存活 id → 持久化（通知本体不持久化，每次刷新重算）
  const markNotificationRead = useCallback(
    (id: string) => {
      setNotifRead((m) => {
        if (m[id]) return m;
        const next = { ...m, [id]: true };
        saveReadMap(pruneReadMap(next, new Set(notifications.map((n) => n.id))));
        return next;
      });
    },
    [notifications],
  );

  const markAllNotificationsRead = useCallback(() => {
    const next: NotificationReadMap = {};
    for (const n of notifications) next[n.id] = true;
    saveReadMap(next);
    setNotifRead(next);
  }, [notifications]);

  const openNotifications = useCallback(() => setNotifOpen(true), []);

  // 通知中心「刷新失败」→ 关闭抽屉 + 复用 focusRequest 机制打开对应账号详情（第五轮机制，不另造）
  const handleOpenAccountFromNotification = useCallback(
    (accountId: string) => {
      setNotifOpen(false);
      openAccountOnDashboard(accountId);
    },
    [openAccountOnDashboard],
  );

  // 托盘菜单点击某账号 → Rust 侧已显示/聚焦窗口，这里复用同一跳转逻辑打开该账号详情抽屉。
  // 非 Tauri 环境（如单元测试 jsdom）没有事件后端：listen 抛错时静默降级，不影响其它功能
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    (async () => {
      try {
        const u = await listen<string>("tray-open-account", (e) => {
          openAccountOnDashboard(e.payload);
        });
        if (disposed) u();
        else unlisten = u;
      } catch {
        // 无事件后端：忽略
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openAccountOnDashboard]);

  // 顶栏进度条：刷新开始即出现；结束后进入完成态（整条淡出）再卸载，避免戛然而止
  useEffect(() => {
    if (refreshing) {
      setProgressVisible(true);
      return;
    }
    if (!progressVisible) return;
    const t = window.setTimeout(() => setProgressVisible(false), 480);
    return () => window.clearTimeout(t);
  }, [refreshing, progressVisible]);

  // 窗口标题动态化：异常数 + 刷新中状态（tauri.conf.json 的静态 title 仍为初始值；纯前端 document.title）
  const failedCount = visibleOutcomes.reduce((n, o) => n + (o.ok ? 0 : 1), 0);
  useEffect(() => {
    const base = "LLM Status Board";
    let title = failedCount > 0 ? `⚠ ${failedCount} 个异常 · ${base}` : base;
    if (refreshing) title += "（刷新中…）";
    document.title = title;
  }, [failedCount, refreshing]);

  // 警示条 hover 提示内容：未读通知涉及的账号（错误优先、按时间序去重，最多列 3 个 +「等 N 个」）
  const alertTip = useMemo(() => {
    const unread = notifications.filter((n) => !notifRead[n.id]);
    if (unread.length === 0) return null;
    const ordered = [...unread].sort((a, b) => Number(b.severity === "err") - Number(a.severity === "err"));
    const names: string[] = [];
    for (const n of ordered) {
      if (!names.includes(n.accountName)) names.push(n.accountName);
    }
    const head = names.slice(0, 3).join("、");
    return names.length > 3 ? `${head} 等 ${names.length} 个账号` : head;
  }, [notifications, notifRead]);

  if (!config) {
    return (
      <div className="boot-screen">
        {loadError ? (
          <div className="error-box">
            <p>配置加载失败</p>
            <pre>{loadError}</pre>
          </div>
        ) : (
          <p className="muted">正在加载…</p>
        )}
      </div>
    );
  }

  return (
    <div className="app-shell">
      <div className="sr-only" role="status" aria-live="polite">
        {refreshAnnouncement}
      </div>
      {/* R16 §5：重试状态**变化**只播报一次（逐秒倒计时本身不播报，见下方 live="off"） */}
      <div className="sr-only" role="status" aria-live="polite">
        {retryAnnouncement}
      </div>
      <header className="topbar">
        <div className="topbar-title">
          <span className="logo-dot" />
          <h1>LLM Status Board</h1>
        </div>
        <div className="topbar-actions">
          {unreadCount > 0 && (
            <button
              type="button"
              className={`alert-chip${hasUnreadError ? " err" : ""}`}
              onClick={openNotifications}
              aria-label={`有 ${unreadCount} 条未读通知，点击查看`}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 2.2 14.6 13.4H1.4Z" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinejoin="round" />
                <path d="M8 6.4v3.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
              </svg>
              <span>{unreadCount}</span>
              {alertTip && (
                <span className="alert-tip" role="tooltip">
                  {alertTip}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            className="btn ghost bell-btn"
            onClick={openNotifications}
            aria-label={unreadCount > 0 ? `通知中心（${unreadCount} 条未读）` : "通知中心"}
            title="通知中心"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M8 1.8a4.4 4.4 0 0 0-4.4 4.4v2.2c0 .8-.32 1.6-.9 2.2l-.6.6h11.8l-.6-.6a3.1 3.1 0 0 1-.9-2.2V6.2A4.4 4.4 0 0 0 8 1.8Z"
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                strokeLinejoin="round"
              />
              <path d="M6.4 13.4a1.7 1.7 0 0 0 3.2 0" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
            </svg>
            {unreadCount > 0 && (
              <span className="bell-badge" aria-hidden="true">
                {unreadCount > 99 ? "99+" : unreadCount}
              </span>
            )}
          </button>
          <button type="button" className="btn ghost refresh-btn" onClick={() => void refresh()} disabled={refreshing}>
            <svg
              className={`refresh-icon${refreshing ? " spinning" : ""}`}
              width="13"
              height="13"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path
                d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89"
                stroke="currentColor"
                strokeWidth="1.7"
                fill="none"
                strokeLinecap="round"
              />
              <path d="M13.7 1.8v2.6h-2.6" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {refreshing ? "刷新中…" : "立即刷新"}
          </button>
          <button className="btn ghost" onClick={() => setHelpOpen(true)}>
            帮助
          </button>
          {/* R22：发现新版本 / 待重启时的顶栏角标（点击去设置页更新）；检查中/失败不在此打扰 */}
          {(updateState.kind === "available" || updateState.kind === "ready") && (
            <button
              type="button"
              className="alert-chip update"
              onClick={() => setView("settings")}
              title={
                updateState.kind === "available"
                  ? `发现新版本 v${updateState.info.version}，点击前往「设置 → 关于与更新」`
                  : `v${updateState.info.version} 已安装，点击前往重启生效`
              }
            >
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M8 12.8V3.2M4.2 7 8 3.2 11.8 7"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>{updateState.kind === "available" ? `v${updateState.info.version}` : "待重启"}</span>
            </button>
          )}
          <button
            className={"btn" + (view === "settings" ? " primary" : " ghost")}
            onClick={() => setView(view === "settings" ? "dashboard" : "settings")}
          >
            {view === "settings" ? "返回看板" : "设置"}
          </button>
        </div>
        {/* 刷新进度条：indeterminate 流动（无单账号完成度数据），结束后淡出卸载 */}
        {progressVisible && (
          <div className={`topbar-progress${refreshing ? " active" : " done"}`} aria-hidden="true" />
        )}
      </header>

      {/* R16 §5：重试倒计时。逐秒更新 → 必须 live="off"，否则读屏每秒播报一次；
          状态变化已由上方 sr-only role="status" 播报一次。 */}
      {retryInfo && retryInfo.remainingSec > 0 && (
        <div className="app-notice-bar">
          <InlineNotice
            tone="warn"
            live="off"
            message={`刷新失败，${retryInfo.remainingSec}s 后重试（第 ${retryInfo.attempt}/${retryInfo.max} 次）`}
          />
        </div>
      )}

      {view === "dashboard" ? (
        <Dashboard
          config={config}
          statuses={statuses}
          refreshing={refreshing}
          lastRefreshAt={lastRefreshAt}
          lastRefreshMs={lastRefreshMs}
          autoRefreshSec={config.settings.autoRefreshSec}
          snapshots={history}
          usageRecords={usageRecords}
          usageError={usageError}
          todayKey={todayKey}
          focusRequest={focusRequest}
          onFocusRequestHandled={clearFocusRequest}
          onGoSettings={() => setView("settings")}
          onAddAccount={handleAddAccount}
          onOpenHelp={() => setHelpOpen(true)}
          onOpenNotifications={openNotifications}
          onRefresh={refresh}
        />
      ) : (
        <SettingsView
          config={config}
          onSave={handleSaveSettings}
          onRefresh={handleSettingsRefresh}
          addRequest={addRequest}
          onAddRequestHandled={clearAddRequest}
          saveState={saveState}
          saveError={saveError}
          onRetrySave={handleRetrySave}
          autostart={autostart}
          onToggleAutostart={handleToggleAutostart}
          notifyPermission={notifyPermission}
          onRequestNotifyPermission={handleRequestNotifyPermission}
          updateState={updateState}
          appVersion={appVersion}
          onCheckUpdate={handleCheckUpdate}
          onInstallUpdate={handleInstallUpdate}
          onRelaunchAfterUpdate={handleRelaunchAfterUpdate}
          onOpenReleasePage={handleOpenReleasePage}
        />
      )}

      {paletteOpen && (
        <CommandPalette
          view={view}
          accounts={config.accounts.filter((a) => a.enabled)}
          onClose={() => setPaletteOpen(false)}
          onRefresh={refresh}
          onNavigate={setView}
          onFocusAccount={openAccountOnDashboard}
          onOpenHelp={() => setHelpOpen(true)}
          onOpenNotifications={openNotifications}
        />
      )}

      {notifOpen && (
        <NotificationCenter
          notifications={notifications}
          readMap={notifRead}
          onMarkRead={markNotificationRead}
          onMarkAllRead={markAllNotificationsRead}
          onClose={() => setNotifOpen(false)}
          onOpenAccount={handleOpenAccountFromNotification}
        />
      )}

      {helpOpen && (
        <HelpPanel
          appVersion={appVersion || undefined}
          onClose={() => setHelpOpen(false)}
          onOpenGuide={handleReopenGuide}
        />
      )}

      {/* 首次启动引导：账号为空且未跳过，或被帮助面板手动重开；空状态文案保留在其下方（测试语义不变） */}
      {(guideOpen || (config.accounts.length === 0 && !guideDismissed)) && (
        <WelcomeGuide onDismiss={dismissGuide} onAddAccount={handleAddAccount} />
      )}

      <footer className="footer">
        <span className="muted">
          数据直接来自各家提供商接口，仅保存在本机。上次刷新：{lastRefreshAt ? new Date(lastRefreshAt).toLocaleString("zh-CN", { hour12: false }) : "—"}
          {lastRefreshMs !== null && ` · 本次耗时 ${formatDurationMs(lastRefreshMs)}`}
        </span>
        <span className="muted footer-hint">
          <kbd>Ctrl</kbd>+<kbd>K</kbd> 快速操作
        </span>
      </footer>
    </div>
  );
}

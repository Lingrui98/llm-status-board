import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import Dashboard from "./components/Dashboard";
import SettingsView from "./components/SettingsView";
import CommandPalette from "./components/CommandPalette";
import WelcomeGuide from "./components/WelcomeGuide";
import HelpPanel from "./components/HelpPanel";
import NotificationCenter from "./components/NotificationCenter";
import type { FocusRequest } from "./components/ProviderCard";
import * as api from "./api";
import type { AppConfig, BalanceSnapshot, ProviderKind, RefreshOutcome } from "./types";
import { formatDurationMs } from "./format";
import { mergeRotatedTokens } from "./configMerge";
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

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    refreshStartRef.current = performance.now();
    setRefreshing(true);
    try {
      const outcomes = await api.refreshAll();
      const map: Record<string, RefreshOutcome> = {};
      for (const o of outcomes) map[o.accountId] = o;
      setStatuses(map);
      const enabledIds = new Set((configRef.current?.accounts ?? []).filter((a) => a.enabled).map((a) => a.id));
      const visibleOutcomes = outcomes.filter((o) => enabledIds.has(o.accountId));
      const okCount = visibleOutcomes.filter((o) => o.ok).length;
      const failCount = visibleOutcomes.length - okCount;
      setRefreshAnnouncement(
        failCount > 0 ? `刷新完成，${okCount} 个账号正常，${failCount} 个异常` : `刷新完成，${okCount} 个账号正常`,
      );
      setLastRefreshAt(new Date().toISOString());
      // 刷新成功后重新拉取余额历史（后端已追加本次快照）
      await loadHistory();
    } catch (e) {
      setLoadError(String(e));
    } finally {
      refreshingRef.current = false;
      // 耗时统计：成功与失败都记录（失败也是一次真实等待），与 IPC 逻辑解耦
      if (refreshStartRef.current !== null) {
        setLastRefreshMs(performance.now() - refreshStartRef.current);
        refreshStartRef.current = null;
      }
      setRefreshing(false);
    }
  }, [loadHistory]);

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
      if (c && c.settings.refreshOnStart && c.accounts.some((a) => a.enabled)) {
        refresh();
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 自动刷新定时器
  useEffect(() => {
    if (refreshTimer.current) {
      window.clearInterval(refreshTimer.current);
      refreshTimer.current = null;
    }
    const sec = config?.settings.autoRefreshSec ?? 0;
    if (sec > 0) {
      refreshTimer.current = window.setInterval(() => refresh(), sec * 1000);
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
          <button type="button" className="btn ghost refresh-btn" onClick={refresh} disabled={refreshing}>
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

      {view === "dashboard" ? (
        <Dashboard
          config={config}
          statuses={statuses}
          refreshing={refreshing}
          lastRefreshAt={lastRefreshAt}
          lastRefreshMs={lastRefreshMs}
          autoRefreshSec={config.settings.autoRefreshSec}
          snapshots={history}
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

      {helpOpen && <HelpPanel onClose={() => setHelpOpen(false)} onOpenGuide={handleReopenGuide} />}

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

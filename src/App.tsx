import { useCallback, useEffect, useRef, useState } from "react";
import Dashboard from "./components/Dashboard";
import SettingsView from "./components/SettingsView";
import * as api from "./api";
import type { AppConfig, BalanceSnapshot, RefreshOutcome } from "./types";

type View = "dashboard" | "settings";

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [statuses, setStatuses] = useState<Record<string, RefreshOutcome>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshAt, setLastRefreshAt] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [history, setHistory] = useState<BalanceSnapshot[]>([]);
  const refreshTimer = useRef<number | null>(null);
  const refreshingRef = useRef(false);

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
    setRefreshing(true);
    try {
      const outcomes = await api.refreshAll();
      const map: Record<string, RefreshOutcome> = {};
      for (const o of outcomes) map[o.accountId] = o;
      setStatuses(map);
      setLastRefreshAt(new Date().toISOString());
      // 刷新成功后重新拉取余额历史（后端已追加本次快照）
      await loadHistory();
    } catch (e) {
      setLoadError(String(e));
    } finally {
      refreshingRef.current = false;
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

  const handleSaveSettings = useCallback(
    async (newConfig: AppConfig) => {
      // 合并后台轮转的 token：如果用户没改这个字段，而磁盘上的值已被刷新轮转更新，采用磁盘最新值
      let toSave = newConfig;
      try {
        const disk = await api.getConfig();
        toSave = {
          ...newConfig,
          accounts: newConfig.accounts.map((a) => {
            const d = disk.accounts.find((x) => x.id === a.id);
            const orig = config?.accounts.find((x) => x.id === a.id);
            if (!d || !orig) return a;
            const merged = { ...a };
            if (a.token === orig.token && d.token && d.token !== orig.token) {
              merged.token = d.token;
            }
            if (
              (a.refreshToken ?? "") === (orig.refreshToken ?? "") &&
              (d.refreshToken ?? "") !== (orig.refreshToken ?? "")
            ) {
              merged.refreshToken = d.refreshToken;
            }
            return merged;
          }),
        };
      } catch {
        // 磁盘读取失败就用用户输入的
      }
      await api.saveConfig(toSave);
      setConfig(toSave);
    },
    [config],
  );

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
      <header className="topbar">
        <div className="topbar-title">
          <span className="logo-dot" />
          <h1>LLM Status Board</h1>
        </div>
        <div className="topbar-actions">
          <button className="btn ghost" onClick={refresh} disabled={refreshing}>
            {refreshing ? "刷新中…" : "立即刷新"}
          </button>
          <button
            className={"btn" + (view === "settings" ? " primary" : " ghost")}
            onClick={() => setView(view === "settings" ? "dashboard" : "settings")}
          >
            {view === "settings" ? "返回看板" : "设置"}
          </button>
        </div>
      </header>

      {view === "dashboard" ? (
        <Dashboard
          config={config}
          statuses={statuses}
          refreshing={refreshing}
          lastRefreshAt={lastRefreshAt}
          autoRefreshSec={config.settings.autoRefreshSec}
          snapshots={history}
        />
      ) : (
        <SettingsView
          config={config}
          onSave={handleSaveSettings}
          onRefresh={refresh}
        />
      )}

      <footer className="footer">
        <span className="muted">
          数据直接来自各家提供商接口，仅保存在本机。Last refresh: {lastRefreshAt ? new Date(lastRefreshAt).toLocaleString("zh-CN", { hour12: false }) : "—"}
        </span>
      </footer>
    </div>
  );
}

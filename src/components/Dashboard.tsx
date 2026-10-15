import { useEffect, useMemo, useState } from "react";
import ProviderCard, { type FocusRequest } from "./ProviderCard";
import SkeletonCard from "./SkeletonCard";
// recharts 图表统一懒加载（拆出首屏主包）
import {
  LazyGlobalDailyUsageChart as GlobalDailyUsageChart,
  LazyGlobalModelUsageChart as GlobalModelUsageChart,
  LazyGlobalBalanceTrendChart as GlobalBalanceTrendChart,
  LazyCostBreakdownChart as CostBreakdownChart,
  pickTrendCurrency,
} from "./charts/lazy";
import { ChartSection } from "./charts/shared";
import type { AppConfig, BalanceSnapshot, Money, ProviderKind, RefreshOutcome } from "../types";
import { formatDurationMs, formatTimeAgo } from "../format";

interface Props {
  config: AppConfig;
  statuses: Record<string, RefreshOutcome>;
  refreshing: boolean;
  lastRefreshAt: string | null;
  /** 本次刷新耗时（毫秒，App 层从 refreshing 起止推导）；null = 本会话尚未刷新过 */
  lastRefreshMs?: number | null;
  autoRefreshSec: number;
  snapshots: BalanceSnapshot[];
  /** 外部「跳转到账号」请求（命令面板 / 数字键），透传给卡片开抽屉 */
  focusRequest?: FocusRequest | null;
  /** 请求已投递给匹配卡片后调用，App 据此清除请求（防重挂载复开） */
  onFocusRequestHandled?: () => void;
  /** 空状态步骤 ①：跳转设置页 */
  onGoSettings?: () => void;
  /** 空状态步骤 ②：去设置添加账号（预选类型） */
  onAddAccount?: (kind: ProviderKind) => void;
  /** 空状态步骤 ③：打开帮助面板（凭证教程） */
  onOpenHelp?: () => void;
  /** 总览条「正常/异常」有异常时点击 → 打开通知中心查看失败项 */
  onOpenNotifications?: () => void;
  /** 点总览条「刷新」时间 = 立即刷新（快捷入口，等同顶栏按钮） */
  onRefresh?: () => void;
}

function aggregate(statuses: Record<string, RefreshOutcome>): { usd: number; cny: number } {
  let usd = 0;
  let cny = 0;
  for (const o of Object.values(statuses)) {
    const b: Money | null | undefined = o.info?.balance;
    if (!b) continue;
    if (b.currency === "USD") usd += b.amount;
    else if (b.currency === "CNY") cny += b.amount;
  }
  return { usd, cny };
}

export default function Dashboard({ config, statuses, refreshing, lastRefreshAt, lastRefreshMs, autoRefreshSec, snapshots, focusRequest, onFocusRequestHandled, onGoSettings, onAddAccount, onOpenHelp, onOpenNotifications, onRefresh }: Props) {
  const enabled = useMemo(() => config.accounts.filter((a) => a.enabled), [config.accounts]);
  const okCount = Object.values(statuses).filter((s) => s.ok).length;
  const failCount = Object.values(statuses).filter((s) => !s.ok).length;
  const totals = aggregate(statuses);

  // 跳转请求投递：匹配卡片的抽屉在子组件副作用中打开（子 effect 先于父 effect 执行），
  // 随后这里通知 App 清除请求，避免视图切换导致卡片重挂载时抽屉意外复开
  useEffect(() => {
    if (focusRequest && enabled.some((a) => a.id === focusRequest.accountId)) {
      onFocusRequestHandled?.();
    }
  }, [focusRequest, enabled, onFocusRequestHandled]);

  // 相对时间（"3分钟前"）每 30s 重算一次
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // 全局统计区块：可折叠（默认展开）；三类数据全无时整个区块不渲染
  const [statsOpen, setStatsOpen] = useState(true);
  const hasStats = useMemo(
    () =>
      enabled.some((acc) => {
        const info = statuses[acc.id]?.info;
        return (info?.dailyUsage?.length ?? 0) > 0 || (info?.modelUsage?.length ?? 0) > 0;
      }) || snapshots.length >= 2,
    [enabled, statuses, snapshots],
  );
  const trendCurrency = useMemo(() => pickTrendCurrency(snapshots), [snapshots]);

  // 首次刷新（无任何旧数据）时显示骨架卡片，避免网格从空白突然跳入
  const showSkeleton = refreshing && Object.keys(statuses).length === 0;
  const skeletonCount = Math.min(Math.max(enabled.length, 3), 4);

  // 总览条「刷新」文本：时刻 + 相对时间 + 刷新方式 + 本次耗时（耗时仅刷新完成后显示）
  const refreshSummary =
    (refreshing
      ? "进行中…"
      : lastRefreshAt
        ? `${new Date(lastRefreshAt).toLocaleTimeString("zh-CN", { hour12: false })} · ${formatTimeAgo(lastRefreshAt, now)}`
        : "—") +
    (autoRefreshSec > 0 ? ` · 每 ${autoRefreshSec}s` : " · 手动") +
    (!refreshing && lastRefreshMs != null ? ` · 耗时 ${formatDurationMs(lastRefreshMs)}` : "");

  if (enabled.length === 0) {
    return (
      <main className="main">
        <div className="empty-state">
          <div className="empty-icon" aria-hidden="true">
            <svg width="52" height="52" viewBox="0 0 52 52" fill="none">
              <rect x="6" y="10" width="40" height="30" rx="5" stroke="currentColor" strokeWidth="2" />
              <path d="M14 30l7-8 5 5 6-7 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M18 44h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </div>
          <h2>还没有任何账号</h2>
          <p className="muted">添加你想监控的 LLM 提供商 / 中转站账号，余额与用量会集中展示在这里。</p>
          <ol className="empty-steps">
            <li>
              <span className="step-num">1</span>
              点击右上角「设置」
              {onGoSettings && (
                <button type="button" className="link-btn empty-step-action" onClick={onGoSettings}>
                  去设置 →
                </button>
              )}
            </li>
            <li>
              <span className="step-num">2</span>
              「+ 添加账号」，选择提供商类型
              {onAddAccount && (
                <button type="button" className="link-btn empty-step-action" onClick={() => onAddAccount("newApi")}>
                  直接添加 →
                </button>
              )}
            </li>
            <li>
              <span className="step-num">3</span>
              填入 Base URL 与密钥，确定即自动保存，返回看板
              {onOpenHelp && (
                <button type="button" className="link-btn empty-step-action" onClick={onOpenHelp}>
                  凭证教程 →
                </button>
              )}
            </li>
          </ol>
        </div>
      </main>
    );
  }

  return (
    <main className="main">
      <div className="summary-bar">
        <div className="summary-item">
          <span className="summary-label">监控账号</span>
          <span className="summary-value">{enabled.length}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">正常 / 异常</span>
          {failCount > 0 && onOpenNotifications ? (
            <button
              type="button"
              className="summary-value summary-jump"
              onClick={onOpenNotifications}
              title="查看异常详情（打开通知中心）"
            >
              <span className="ok-text">{okCount}</span>
              <span className="muted"> / </span>
              <span className="fail-text">{failCount}</span>
            </button>
          ) : (
            <span className="summary-value">
              <span className="ok-text">{okCount}</span>
              <span className="muted"> / </span>
              <span className="fail-text">{failCount}</span>
            </span>
          )}
        </div>
        <div className="summary-item">
          <span className="summary-label">余额合计 (USD)</span>
          <span className="summary-value">${totals.usd.toFixed(2)}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">余额合计 (CNY)</span>
          <span className="summary-value">¥{totals.cny.toFixed(2)}</span>
        </div>
        <div className="summary-item">
          <span className="summary-label">刷新</span>
          {refreshing || !onRefresh ? (
            <span className="summary-value small">{refreshSummary}</span>
          ) : (
            <button
              type="button"
              className="summary-value small summary-refresh-btn"
              onClick={onRefresh}
              title="点击立即刷新"
            >
              {refreshSummary}
            </button>
          )}
        </div>
      </div>

      {hasStats && (
        <section className="global-stats">
          <button
            className="global-stats-head"
            onClick={() => setStatsOpen((v) => !v)}
            aria-expanded={statsOpen}
          >
            <span className="global-stats-title">全局统计</span>
            <span className="muted small">跨账号汇总视图</span>
            <svg className="chevron" width="12" height="12" viewBox="0 0 10 10" aria-hidden="true">
              <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {statsOpen && (
            <div className="global-stats-grid">
              <div className="global-chart span-2">
                <ChartSection title="全账号用量趋势（近 14 天）">
                  <GlobalDailyUsageChart accounts={enabled} statuses={statuses} />
                </ChartSection>
              </div>
              <div className="global-chart">
                <ChartSection title="全账号模型用量 TOP 8">
                  <GlobalModelUsageChart accounts={enabled} statuses={statuses} />
                </ChartSection>
              </div>
              <div className="global-chart">
                <ChartSection title={trendCurrency ? `余额趋势（多账号 · ${trendCurrency}）` : "余额趋势（多账号）"}>
                  <GlobalBalanceTrendChart snapshots={snapshots} accounts={enabled} />
                </ChartSection>
              </div>
              <div className="global-chart span-2">
                <ChartSection title="今日费用构成（按账号 · 分币种）">
                  <CostBreakdownChart accounts={enabled} statuses={statuses} />
                </ChartSection>
              </div>
            </div>
          )}
        </section>
      )}

      <div className="card-grid">
        {showSkeleton
          ? Array.from({ length: skeletonCount }, (_, i) => <SkeletonCard key={`skl-${i}`} />)
          : enabled.map((acc) => (
              <ProviderCard
                key={acc.id}
                account={acc}
                outcome={statuses[acc.id]}
                refreshing={refreshing}
                snapshots={snapshots}
                now={now}
                focusRequest={focusRequest}
              />
            ))}
      </div>
    </main>
  );
}

import { useEffect, useMemo, useState } from "react";
import ProviderCard, { type FocusRequest } from "./ProviderCard";
import SkeletonCard from "./SkeletonCard";
import MasonryGrid from "./MasonryGrid";
import OverviewCards from "./OverviewCards";
import GlobalStatsCard from "./GlobalStatsCard";
import InsightsPanel from "./InsightsPanel";
import AnalysisView from "./AnalysisView";
import type { AppConfig, BalanceSnapshot, ProviderKind, RefreshOutcome, UsageRecord } from "../types";
import { aggregateBalances } from "../balances";
import { toLocalDateKey } from "../usageHistory";
import { normalizeLocalDay } from "../localDay";

interface Props {
  config: AppConfig;
  statuses: Record<string, RefreshOutcome>;
  refreshing: boolean;
  lastRefreshAt: string | null;
  /** 本次刷新耗时（毫秒，App 层从 refreshing 起止推导）；null = 本会话尚未刷新过 */
  lastRefreshMs?: number | null;
  autoRefreshSec: number;
  snapshots: BalanceSnapshot[];
  /** R15：本地用量历史（分析视图数据源） */
  usageRecords?: UsageRecord[];
  /** R15：用量历史读取/写入失败的轻量提示（不阻塞看板） */
  usageError?: string | null;
  /** R15：「今天」本地日历日（App 层单一来源，保证分析窗口口径一致） */
  todayKey?: string;
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
  /** 从异常卡片直接打开对应账号的编辑表单 */
  onEditAccount?: (accountId: string) => void;
}

export default function Dashboard({ config, statuses, refreshing, lastRefreshAt, lastRefreshMs, autoRefreshSec, snapshots, usageRecords, usageError, todayKey, focusRequest, onFocusRequestHandled, onGoSettings, onAddAccount, onOpenHelp, onOpenNotifications, onRefresh, onEditAccount }: Props) {
  const enabled = useMemo(() => config.accounts.filter((a) => a.enabled), [config.accounts]);
  // 余额合计口径与悬停浮层共用（src/balances.ts），按币种分开、绝不跨币种相加
  const totals = useMemo(() => aggregateBalances(Object.values(statuses)), [statuses]);

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

  // 全局统计区块：只在有效用量或可用余额趋势存在时显示，忽略占位行和停用账号。
  const hasStats = useMemo(() => {
    const finite = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value);
    const hasUsage = enabled.some((acc) => {
      const info = statuses[acc.id]?.info;
      const daily = (info?.dailyUsage ?? []).some(
        (point) => !!point.date && !!normalizeLocalDay(point.date) && (finite(point.requests) || finite(point.cost)),
      );
      const models = (info?.modelUsage ?? []).some((point) => !!point.model && finite(point.requests));
      return daily || models;
    });
    if (hasUsage) return true;
    const ids = new Set(enabled.map((account) => account.id));
    const trendTimes = new Set(
      snapshots
        .filter((s) => ids.has(s.accountId) && Number.isFinite(Date.parse(s.ts)) && Number.isFinite(s.balance))
        .map((s) => Date.parse(s.ts)),
    );
    return trendTimes.size >= 2;
  }, [enabled, statuses, snapshots]);

  // 首次刷新（无任何旧数据）时显示骨架卡片，避免网格从空白突然跳入
  const showSkeleton = refreshing && Object.keys(statuses).length === 0;
  const skeletonCount = Math.min(Math.max(enabled.length, 3), 4);

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
      <OverviewCards
        accounts={enabled}
        statuses={statuses}
        totals={totals}
        refreshing={refreshing}
        lastRefreshAt={lastRefreshAt}
        lastRefreshMs={lastRefreshMs}
        autoRefreshSec={autoRefreshSec}
        todayKey={todayKey}
        onOpenNotifications={onOpenNotifications}
        onRefresh={onRefresh}
      />

      {hasStats && <GlobalStatsCard accounts={enabled} statuses={statuses} snapshots={snapshots} />}

      {/* 各列独立累计高度，避免普通 Grid 的行高耦合；保留 enabled 的原始顺序。 */}
      <MasonryGrid>
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
                todayKey={todayKey}
                focusRequest={focusRequest}
                onRetry={onRefresh}
                onEdit={onEditAccount ? () => onEditAccount(acc.id) : undefined}
              />
            ))}
      </MasonryGrid>

      <div className="dashboard-bottom-grid">
        {/* R14 洞察区：内部计算完全来自 history 快照，与上方全局统计的 hasStats 判据解耦 */}
        <InsightsPanel
          accounts={config.accounts}
          statuses={statuses}
          snapshots={snapshots}
          settings={config.settings}
          onRefresh={onRefresh}
        />

        {/* R15 深度分析区：数据源是本地用量历史（usage-history.json）+ results.json 的 modelUsage */}
        <AnalysisView
          records={usageRecords ?? []}
          statuses={statuses}
          accounts={config.accounts}
          today={todayKey ?? toLocalDateKey()}
          errorNote={usageError ?? undefined}
          onRefresh={onRefresh}
        />
      </div>
    </main>
  );
}

import { useEffect, useMemo, useState } from "react";
import ProviderCard from "./ProviderCard";
import GlobalDailyUsageChart from "./charts/GlobalDailyUsageChart";
import GlobalModelUsageChart from "./charts/GlobalModelUsageChart";
import GlobalBalanceTrendChart, { pickTrendCurrency } from "./charts/GlobalBalanceTrendChart";
import { ChartSection } from "./charts/shared";
import type { AppConfig, BalanceSnapshot, Money, RefreshOutcome } from "../types";
import { formatTimeAgo } from "../format";

interface Props {
  config: AppConfig;
  statuses: Record<string, RefreshOutcome>;
  refreshing: boolean;
  lastRefreshAt: string | null;
  autoRefreshSec: number;
  snapshots: BalanceSnapshot[];
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

export default function Dashboard({ config, statuses, refreshing, lastRefreshAt, autoRefreshSec, snapshots }: Props) {
  const enabled = config.accounts.filter((a) => a.enabled);
  const okCount = Object.values(statuses).filter((s) => s.ok).length;
  const failCount = Object.values(statuses).filter((s) => !s.ok).length;
  const totals = aggregate(statuses);

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
            </li>
            <li>
              <span className="step-num">2</span>
              「+ 添加账号」，选择提供商类型
            </li>
            <li>
              <span className="step-num">3</span>
              填入 Base URL 与密钥，保存后返回看板
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
          <span className="summary-value">
            <span className="ok-text">{okCount}</span>
            <span className="muted"> / </span>
            <span className="fail-text">{failCount}</span>
          </span>
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
          <span className="summary-value small">
            {refreshing
              ? "进行中…"
              : lastRefreshAt
                ? `${new Date(lastRefreshAt).toLocaleTimeString("zh-CN", { hour12: false })} · ${formatTimeAgo(lastRefreshAt, now)}`
                : "—"}
            {autoRefreshSec > 0 ? ` · 每 ${autoRefreshSec}s` : " · 手动"}
          </span>
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
                <ChartSection title="全账号请求趋势（近 14 天）">
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
            </div>
          )}
        </section>
      )}

      <div className="card-grid">
        {enabled.map((acc) => (
          <ProviderCard
            key={acc.id}
            account={acc}
            outcome={statuses[acc.id]}
            refreshing={refreshing}
            snapshots={snapshots}
          />
        ))}
      </div>
    </main>
  );
}

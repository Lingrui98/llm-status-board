// R14 洞察区：可折叠面板，把余额快照换算成「日均消耗 / 可支撑天数 / 本月预计支出 / 消耗最快账号」。
// 计算全部在纯函数 src/insights.ts 完成，本组件只负责取数、分组、展示与导出入口。
// 原语来自美工的设计系统：src/components/ui/（StatTile / MiniSparkline / SegmentedControl）。

import { useMemo, useState } from "react";
import StatTile, { type StatTone } from "./ui/StatTile";
import MiniSparkline, { type SparkTone } from "./ui/MiniSparkline";
import SegmentedControl from "./ui/SegmentedControl";
import {
  SKIP_REASON_LABELS,
  buildInsightReport,
  fastestSummaryText,
  formatBurnRate,
  formatDaysLeft,
  resolveInsightWindowDays,
  type AccountInsight,
  type MonthProjection,
} from "../insights";
import { exportUsageCsv } from "../exportReport";
import { formatDecimal } from "../format";
import type { AccountConfig, BalanceSnapshot, RefreshOutcome, Settings } from "../types";

interface Props {
  accounts: AccountConfig[];
  statuses: Record<string, RefreshOutcome>;
  snapshots: BalanceSnapshot[];
  /** 洞察窗口天数与开关来源（config.settings） */
  settings: Settings;
}

/** 币种展示顺序：USD、CNY 优先（看板主要口径），其余按字典序 */
function currencyRank(currency: string): number {
  if (currency === "USD") return 0;
  if (currency === "CNY") return 1;
  return 2;
}

/** 币种前缀符号（仅展示用；未知币种退化为代码） */
function amountText(amount: number, currency: string): string {
  const n = formatDecimal(amount);
  if (currency === "USD") return `$${n}`;
  if (currency === "CNY") return `¥${n}`;
  return `${n} ${currency}`;
}

function daysLeftTone(days: number | null): StatTone {
  if (days === null) return "default";
  if (days <= 3) return "err";
  if (days <= 7) return "warn";
  return "ok";
}

function sparkTone(days: number | null): SparkTone {
  if (days === null) return "accent";
  if (days <= 3) return "err";
  if (days <= 7) return "warn";
  return "ok";
}

/** 余额走势的百分比变化（首→末）；样本不足或首值为 0 时为 null */
function trendOf(series: readonly number[]): { direction: "up" | "down" | "flat"; label: string } | null {
  if (series.length < 2) return null;
  const first = series[0];
  const last = series[series.length - 1];
  if (!Number.isFinite(first) || !Number.isFinite(last) || first === 0) return null;
  const pct = ((last - first) / Math.abs(first)) * 100;
  const direction = pct > 0.05 ? "up" : pct < -0.05 ? "down" : "flat";
  const sign = pct > 0 ? "+" : "";
  return { direction, label: `${sign}${pct.toFixed(0)}%` };
}

function AccountTile({ account }: { account: AccountInsight }) {
  const trend = trendOf(account.series);
  const degraded = account.burnRate === null;
  return (
    <StatTile
      label={`${account.accountName} · ${account.currency}`}
      value={degraded ? null : formatDaysLeft(account.daysLeft)}
      unit={degraded ? undefined : "可支撑"}
      hint={
        degraded
          ? `${account.reason === null ? "数据不足" : SKIP_REASON_LABELS[account.reason]}｜余额 ${
              account.currentBalance === null ? "—" : amountText(account.currentBalance, account.currency)
            }`
          : `日均 ${formatBurnRate(account.burnRate)} ${account.currency}/天｜余额 ${
              account.currentBalance === null ? "—" : amountText(account.currentBalance, account.currency)
            }`
      }
      tone={daysLeftTone(account.daysLeft)}
      trend={trend?.direction ?? null}
      trendTone={trend?.direction === "up" ? "ok" : trend?.direction === "down" ? "warn" : "default"}
      trendLabel={trend?.label}
    >
      <MiniSparkline
        data={account.series}
        tone={sparkTone(account.daysLeft)}
        ariaLabel={`${account.accountName} 余额走势`}
        emptyText="样本不足"
      />
    </StatTile>
  );
}

function ProjectionTile({ projection }: { projection: MonthProjection }) {
  return (
    <StatTile
      label={`本月预计支出 · ${projection.currency}`}
      value={amountText(projection.projectedTotal, projection.currency)}
      hint={
        projection.degraded
          ? `已发生 ${amountText(projection.elapsedSpend, projection.currency)}｜剩余 ${projection.remainingDays} 天暂无消耗速率`
          : `已发生 ${amountText(projection.elapsedSpend, projection.currency)} + 剩余 ${projection.remainingDays} 天预测 ${amountText(
              projection.projectedRemaining,
              projection.currency,
            )}`
      }
      tone="default"
    />
  );
}

export default function InsightsPanel({ accounts, statuses, snapshots, settings }: Props) {
  const [open, setOpen] = useState(true);
  const [currencyFilter, setCurrencyFilter] = useState<string>("all");
  const [exportState, setExportState] = useState<{ kind: "idle" | "busy" | "ok" | "err"; text: string }>({
    kind: "idle",
    text: "",
  });

  const windowDays = resolveInsightWindowDays(settings);

  const enabled = useMemo(() => accounts.filter((a) => a.enabled), [accounts]);

  const names = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of enabled) m[a.id] = a.name;
    return m;
  }, [enabled]);

  const report = useMemo(() => {
    // AC-5（D-2）：刷新**失败**（显式 ok:false）的启用账号不参与洞察 —— 引擎内部还有一道
    // 同样的过滤（buildInsightReport 是唯一权威过滤点），这里只是把「明确失败」的账号挡在门外。
    // 无 statuses 条目（本会话尚未刷新，例如刚启动只读到了历史结果）的账号保留旧快照的洞察价值；
    // 不合成 ok:false，否则会把「未刷新」误判成「失败」。
    const accountIds = enabled.filter((a) => statuses[a.id]?.ok !== false).map((a) => a.id);
    const outcomes = accountIds
      .map((id) => statuses[id])
      .filter((o): o is RefreshOutcome => o !== undefined);
    return buildInsightReport(snapshots, outcomes, { names, accountIds, windowDays });
  }, [enabled, statuses, snapshots, windowDays, names]);

  // 币种页签：只列出洞察报告里真实出现过的法币（跳过 credits 等点数单位）
  const currencies = useMemo(() => {
    const set = new Set<string>();
    for (const a of report.accounts) set.add(a.currency);
    return [...set].sort((a, b) => currencyRank(a) - currencyRank(b) || a.localeCompare(b));
  }, [report.accounts]);

  const visibleCurrencies = currencyFilter === "all" ? currencies : currencies.filter((c) => c === currencyFilter);

  const shownAccounts = report.accounts.filter((a) => visibleCurrencies.includes(a.currency));
  const shownProjections = report.projections.filter((p) => visibleCurrencies.includes(p.currency));

  // 被跳过的组：按币种过滤后展示，让「为什么没有数据」始终可解释
  const shownSkipped = report.skipped.filter(
    (s) => currencyFilter === "all" || s.currency === currencyFilter || s.reason === "nonFiat",
  );

  const handleExport = async () => {
    setExportState({ kind: "busy", text: "导出中…" });
    const result = await exportUsageCsv(enabled, Object.values(statuses), snapshots);
    if (result.status === "cancelled") {
      setExportState({ kind: "idle", text: "" });
      return;
    }
    if (result.status === "error") {
      setExportState({ kind: "err", text: `导出失败：${result.message}` });
      return;
    }
    setExportState({ kind: "ok", text: `已导出 ${result.rowCount} 行到 ${result.path}` });
  };

  // 无任何快照：不渲染空壳区块，但保留「导出 CSV」入口（报表本身仍有结果数据可用）
  const hasSnapshots = snapshots.some((s) => enabled.some((a) => a.id === s.accountId));

  if (!hasSnapshots) {
    return (
      <section className="global-stats insights-panel" aria-label="数据洞察">
        <div className="insights-panel-head">
          <span className="global-stats-title">洞察</span>
          <span className="muted small">日均消耗与余额预测</span>
        </div>
        <div className="insights-panel-body">
          <div className="insights-empty">
            暂无历史数据 —— 刷新几次后即可看到日均消耗与余额可支撑天数预测。
          </div>
          <div className="insights-panel-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={handleExport}
              disabled={exportState.kind === "busy"}
              title="把各账号每日用量与余额快照导出为 CSV（UTF-8 BOM，Excel 可直接打开）"
            >
              {exportState.kind === "busy" ? "导出中…" : "导出 CSV"}
            </button>
            {exportState.text && (
              <span className={exportState.kind === "err" ? "insights-notice err" : "insights-notice"} role="status">
                {exportState.text}
              </span>
            )}
          </div>
        </div>
      </section>
    );
  }

  const riskClass = report.risk === "err" ? " err" : report.risk === "warn" ? " warn" : "";

  return (
    <section className="global-stats insights-panel" aria-label="数据洞察">
      <button
        type="button"
        className="global-stats-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="global-stats-title">洞察</span>
        <span className="muted small">近 {report.windowDays} 天窗口 · 日均消耗与余额预测</span>
        <svg className="chevron" width="12" height="12" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <>
          <div className="insights-panel-body">
            {report.fastest.length > 0 && (
              <div className="insights-notices">
                {report.fastest.map((f) => (
                  <p key={`${f.accountId}-${f.currency}`} className={`insights-notice${riskClass}`} role="status">
                    <span aria-hidden="true">⚠</span>
                    {fastestSummaryText(f)}
                  </p>
                ))}
              </div>
            )}

            {currencies.length > 1 && (
              <SegmentedControl
                options={[
                  { value: "all", label: "全部币种" },
                  ...currencies.map((c) => ({ value: c, label: c })),
                ]}
                value={currencyFilter}
                onChange={setCurrencyFilter}
                ariaLabel="洞察币种筛选"
              />
            )}

            <div className="insights-grid">
              {shownAccounts.map((a) => (
                <AccountTile key={`${a.accountId}-${a.currency}`} account={a} />
              ))}
              {shownProjections.map((p) => (
                <ProjectionTile key={`proj-${p.currency}`} projection={p} />
              ))}
            </div>

            {shownAccounts.length === 0 && shownProjections.length === 0 && (
              <div className="insights-empty">该币种暂无可用快照，换个币种或稍后刷新。</div>
            )}

            {shownSkipped.length > 0 && (
              <ul className="insights-skip-list">
                {shownSkipped.map((s) => (
                  <li key={`${s.accountId}-${s.currency}-${s.reason}`} className="muted small">
                    {names[s.accountId] ?? s.accountId}（{s.currency}）：{SKIP_REASON_LABELS[s.reason]}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="insights-panel-actions">
            <button
              type="button"
              className="btn ghost"
              onClick={handleExport}
              disabled={exportState.kind === "busy"}
              title="把各账号每日用量与余额快照导出为 CSV（UTF-8 BOM，Excel 可直接打开）"
            >
              {exportState.kind === "busy" ? "导出中…" : "导出 CSV"}
            </button>
            {exportState.text && (
              <span
                className={exportState.kind === "err" ? "insights-notice err" : "insights-notice"}
                role="status"
                aria-live="polite"
              >
                {exportState.text}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

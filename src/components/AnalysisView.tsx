// R15 分析视图：可折叠分区，消费 src/analysis.ts 的纯函数结果，用 R15 设计系统原语渲染。
// - recharts 图表（逐日趋势）走 charts/lazy 懒加载边界，不把 recharts 拉回主包；
// - 「今天」由 App 层注入（单一来源，避免多处 new Date() 造成跨时区不一致）；
// - 无本地历史时显示明确占位，**不回退** results.json（§3.5.4，避免「看起来有数据其实只有一天」）。

import { useMemo, useState } from "react";
import { DeltaBadge, HeatStrip, MiniBars, RankingRow, StatTile } from "./ui";
import type { HeatStripCell } from "./ui";
import { ChartEmpty, ChartSection } from "./charts/shared";
import { LazyAnalysisTrendChart as AnalysisTrendChart } from "./charts/lazy";
import {
  ANOMALY_WINDOW_DAYS,
  PERIOD_DAYS,
  compareEfficiency,
  comparePeriods,
  dateRange,
  detectAnomalies,
  rankModelCosts,
  shiftDateKey,
  type AnalysisReport,
  type EfficiencyEntry,
  type ModelRankEntry,
} from "../analysis";
import { formatDecimal, formatNumber } from "../format";
import { mergedView } from "../usageHistory";
import type { AccountConfig, RefreshOutcome, UsagePoint, UsageRecord } from "../types";

interface Props {
  /** usage-history 原始记录（内部做合并去重与启用账号过滤） */
  records: UsageRecord[];
  /** results.json 的最近刷新结果（模型维度唯一来源） */
  statuses: Record<string, RefreshOutcome>;
  accounts: AccountConfig[];
  /** 本地日历日 "YYYY-MM-DD"，由 App 层注入 */
  today: string;
  /** usage-history 读取失败时的可读提示（非阻塞） */
  errorNote?: string;
  /** 本地历史刚开始积累时的提示（例如记录数很少） */
  hintNote?: string;
}

/** 逐日花费序列（按币种）：缺失日补 0，保证 x 轴连续 */
function dailySeries(
  records: readonly UsageRecord[],
  currency: string,
  days: number,
  today: string,
): { date: string; value: number }[] {
  const keys = dateRange(shiftDateKey(today, -(days - 1)), today);
  const byDate = new Map<string, number>();
  for (const r of records) {
    if (r.currency !== currency) continue;
    byDate.set(r.date, (byDate.get(r.date) ?? 0) + (r.cost ?? 0));
  }
  return keys.map((date) => ({ date, value: byDate.get(date) ?? 0 }));
}

function deltaTone(delta: number): "default" | "ok" | "warn" | "err" {
  // 花费上涨对用户是坏消息 → err；下降 → ok；持平 → default
  if (delta > 0) return "err";
  if (delta < 0) return "ok";
  return "default";
}

export default function AnalysisView({ records, statuses, accounts, today, errorNote, hintNote }: Props) {
  const [open, setOpen] = useState(true);

  const enabled = useMemo(() => accounts.filter((a) => a.enabled), [accounts]);
  const names = useMemo(() => {
    const m: Record<string, string> = {};
    for (const a of enabled) m[a.id] = a.name;
    return m;
  }, [enabled]);

  const enabledIds = useMemo(() => new Set(enabled.map((a) => a.id)), [enabled]);
  const merged = useMemo(
    () => mergedView(records.filter((r) => enabledIds.has(r.accountId))),
    [records, enabledIds],
  );

  const period = useMemo(() => comparePeriods(merged, today), [merged, today]);
  const efficiency = useMemo(() => compareEfficiency(merged, today), [merged, today]);
  const anomalies = useMemo(() => detectAnomalies(merged, today), [merged, today]);

  const models = useMemo(() => {
    const map = new Map<string, readonly UsagePoint[] | null | undefined>();
    for (const acc of enabled) {
      const o = statuses[acc.id];
      if (!o?.ok || !o.info) continue;
      if ((o.info.modelUsage?.length ?? 0) > 0) map.set(acc.id, o.info.modelUsage);
    }
    return rankModelCosts(map);
  }, [enabled, statuses]);

  const report: AnalysisReport = useMemo(
    () => ({ today, period, models, efficiency, anomalies, hasUsageHistory: merged.length > 0 }),
    [today, period, models, efficiency, anomalies, merged.length],
  );

  // 异常日热力条：近 14 天「全部账号合计花费」（按主币种），异常日用 err 档标记
  const heatCurrency = period.byCurrency[0]?.currency ?? "USD";
  const heatCells: HeatStripCell[] = useMemo(() => {
    const series = dailySeries(merged, heatCurrency, ANOMALY_WINDOW_DAYS, today);
    const anomalyDates = new Set(anomalies.days.map((d) => d.date));
    const peak = Math.max(...series.map((s) => s.value), 0);
    return series.map((s) => ({
      label: s.date,
      value: s.value,
      level: anomalyDates.has(s.date) && s.value > 0 ? 4 : s.value <= 0 ? 0 : Math.max(1, Math.ceil((s.value / (peak || 1)) * 3)),
      title: anomalyDates.has(s.date)
        ? `${s.date}：${formatDecimal(s.value)} ${heatCurrency}（异常日）`
        : `${s.date}：${formatDecimal(s.value)} ${heatCurrency}`,
    }));
  }, [merged, heatCurrency, today, anomalies.days]);

  const trendPoints = useMemo(
    () => dailySeries(merged, heatCurrency, PERIOD_DAYS * 2, today),
    [merged, heatCurrency, today],
  );

  const modelRows = models.byCurrency[0]?.entries ?? [];
  const modelCurrency = models.byCurrency[0]?.currency ?? "";

  return (
    <section className="global-stats analysis-panel" aria-label="深度分析">
      <button type="button" className="global-stats-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="global-stats-title">深度分析</span>
        <span className="muted small">周对比 · 模型成本 · 账号效率 · 异常日</span>
        <svg className="chevron" width="12" height="12" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="analysis-body">
          {errorNote && <p className="analysis-note err">{errorNote}</p>}
          {!report.hasUsageHistory ? (
            <div className="insights-empty">
              暂无本地用量历史 —— 本地历史从本版本开始积累，刷新几次后即可看到周对比、模型成本与异常日分析。
              {hintNote ? `（${hintNote}）` : ""}
            </div>
          ) : (
            <>
              {/* ① 周期对比（近 7 天 vs 前 7 天） */}
              <ChartSection title={`周期对比（近 ${PERIOD_DAYS} 天 vs 前 ${PERIOD_DAYS} 天）`}>
                <div className="stat-grid-tight">
                  {period.byCurrency.length === 0 ? (
                    <ChartEmpty height={72} text="本期与上期均无花费记录" />
                  ) : (
                    period.byCurrency.map((c) => (
                      <StatTile
                        key={c.currency}
                        label={`${c.currency} 花费`}
                        value={formatDecimal(c.costThis)}
                        unit={c.currency}
                        hint={`日均 ${formatDecimal(c.dailyAvgThis)} ｜ 上期 ${formatDecimal(c.costPrev)}`}
                        tone={deltaTone(c.delta)}
                      >
                        <DeltaBadge
                          value={c.deltaPct}
                          direction={c.delta > 0 ? "up" : c.delta < 0 ? "down" : "flat"}
                          tone={deltaTone(c.delta)}
                          label={c.label ?? undefined}
                          title="花费变化：上涨为不利变化"
                        />
                      </StatTile>
                    ))
                  )}
                  <StatTile
                    label="请求数"
                    value={formatNumber(period.requests.thisTotal)}
                    hint={`上期 ${formatNumber(period.requests.prevTotal)}`}
                  >
                    <DeltaBadge
                      value={period.requests.deltaPct}
                      direction={period.requests.delta > 0 ? "up" : period.requests.delta < 0 ? "down" : "flat"}
                      tone={deltaTone(period.requests.delta)}
                      label={period.requests.label ?? undefined}
                    />
                  </StatTile>
                </div>

                <AnalysisTrendChart
                  points={trendPoints}
                  unit={heatCurrency}
                  label={`${heatCurrency} 花费`}
                  emptyNote="近 14 天暂无花费记录"
                />
                {trendPoints.some((p) => p.value > 0) && (
                  <MiniBars
                    data={trendPoints.map((p) => p.value)}
                    ariaLabel={`近 ${PERIOD_DAYS * 2} 天花费柱状`}
                  />
                )}
              </ChartSection>

              {/* ② 模型成本排行（results.json#modelUsage，跨账号合并） */}
              <ChartSection title="模型成本排行（跨账号合并 · Top 5）">
                {models.empty ? (
                  <ChartEmpty height={72} text="该提供商未返回模型维度用量" />
                ) : (
                  <>
                    {models.byCurrency.map((board) => (
                      <div key={board.currency} className="analysis-subgroup">
                        <div className="muted small">{board.currency}</div>
                        <ol className="rank-list">
                          {board.entries.map((e: ModelRankEntry, i: number) => (
                            <RankingRow
                              key={`${board.currency}-${e.model}`}
                              rank={i + 1}
                              name={e.model}
                              value={e.cost}
                              unit={` ${board.currency}`}
                              max={board.entries[0]?.cost}
                            />
                          ))}
                        </ol>
                      </div>
                    ))}
                    {models.noCost.length > 0 && (
                      <div className="analysis-subgroup">
                        <div className="muted small">无成本数据（按 Tokens）</div>
                        <ol className="rank-list">
                          {models.noCost.map((e, i) => (
                            <RankingRow
                              key={`nocost-${e.model}`}
                              rank={i + 1}
                              name={e.model}
                              value={e.totalTokens}
                              unit=" tokens"
                              precision={0}
                              max={models.noCost[0]?.totalTokens}
                              title="该模型没有 cost 字段，只能按 Tokens 排序"
                            />
                          ))}
                        </ol>
                      </div>
                    )}
                  </>
                )}
              </ChartSection>

              {/* ③ 账号效率对比（按币种分组，跨币种不比较） */}
              <ChartSection title={`账号效率对比（近 ${PERIOD_DAYS} 天 · 按币种分组）`}>
                {efficiency.empty ? (
                  <ChartEmpty height={72} text="近 7 天无可比较的账号用量" />
                ) : (
                  efficiency.byCurrency.map((board) => (
                    <div key={board.currency} className="analysis-subgroup">
                      <div className="muted small">
                        {board.currency}
                        {board.worstAccountId ? ` ｜ 效率最差：${names[board.worstAccountId] ?? board.worstAccountId}` : ""}
                      </div>
                      <ol className="rank-list">
                        {board.entries.map((e: EfficiencyEntry, i: number) => (
                          <RankingRow
                            key={`${board.currency}-${e.accountId}`}
                            rank={i + 1}
                            name={names[e.accountId] ?? e.accountId}
                            value={e.costPerRequest}
                            unit={` ${board.currency}/请求`}
                            precision={4}
                            max={Math.max(...board.entries.map((x) => x.costPerRequest ?? 0))}
                            tone={e.worst ? "err" : "default"}
                            title={`花费 ${formatDecimal(e.cost)} ${board.currency} ｜ 请求 ${formatNumber(e.requests)}`}
                          />
                        ))}
                      </ol>
                    </div>
                  ))
                )}
              </ChartSection>

              {/* ④ 异常日（近 14 天，中位数 × 2.5） */}
              <ChartSection title={`异常日检测（近 ${ANOMALY_WINDOW_DAYS} 天 · 中位数 × 2.5）`}>
                <HeatStrip
                  cells={heatCells}
                  unit={` ${heatCurrency}`}
                  ariaLabel={`近 ${ANOMALY_WINDOW_DAYS} 天花费热力条`}
                  emptyText="暂无逐日记录"
                />
                {anomalies.days.length === 0 ? (
                  <p className="muted small">
                    {anomalies.evaluated === 0
                      ? "样本不足（需要至少 5 天有记录且中位数大于 0）"
                      : "未发现异常日"}
                  </p>
                ) : (
                  <ol className="rank-list">
                    {anomalies.days.map((d, i) => (
                      <RankingRow
                        key={`${d.accountId}-${d.date}`}
                        rank={i + 1}
                        name={`${names[d.accountId] ?? d.accountId} · ${d.date}`}
                        value={d.cost}
                        unit={` ${d.currency}`}
                        max={anomalies.days[0]?.cost}
                        tone="err"
                        title={`中位数 ${formatDecimal(d.median)}，倍数 ${d.multiple}×`}
                      />
                    ))}
                  </ol>
                )}
              </ChartSection>

              {hintNote && <p className="analysis-note">{hintNote}</p>}
            </>
          )}
        </div>
      )}
    </section>
  );
}

import { useState } from "react";
import type { AccountConfig, BalanceSnapshot, RefreshOutcome } from "../types";
import { SegmentedControl } from "./ui";
import {
  LazyGlobalDailyUsageChart as GlobalDailyUsageChart,
  LazyGlobalModelUsageChart as GlobalModelUsageChart,
  LazyGlobalBalanceTrendChart as GlobalBalanceTrendChart,
  LazyCostBreakdownChart as CostBreakdownChart,
} from "./charts/lazy";

type StatsTab = "usage" | "models" | "balance" | "cost";
type UsageDays = "7" | "14" | "30";

interface Props {
  accounts: AccountConfig[];
  statuses: Record<string, RefreshOutcome>;
  snapshots: BalanceSnapshot[];
  now?: number;
}

const TAB_OPTIONS = [
  { value: "usage", label: "用量趋势" },
  { value: "models", label: "模型用量" },
  { value: "balance", label: "余额趋势" },
  { value: "cost", label: "费用构成" },
] as const;

export default function GlobalStatsCard({ accounts, statuses, snapshots, now }: Props) {
  const [tab, setTab] = useState<StatsTab>("usage");
  const [usageDays, setUsageDays] = useState<UsageDays>("14");
  const openAiAccounts = accounts.filter((account) => account.kind === "openAi");
  const errors = openAiAccounts.flatMap(({ id, name }) => {
    const billing = statuses[id]?.info?.openAiBilling;
    return [
      ...(billing?.usageError && (tab === "usage" || tab === "models")
        ? [{ key: `${id}-usage`, label: "模型用量", message: billing.usageError, name }] : []),
      ...(billing?.costsError && (tab === "usage" || tab === "cost")
        ? [{ key: `${id}-cost`, label: "费用", message: billing.costsError, name }] : []),
    ];
  });

  return (
    <section className="global-stats global-stats-tabs" aria-label="全局统计">
      <div className="global-stats-main-head">
        <div className="global-stats-heading">
          <span className="global-stats-title">全局统计</span>
          <span className="muted small">跨账号汇总视图</span>
        </div>
        <SegmentedControl
          options={TAB_OPTIONS}
          value={tab}
          onChange={setTab}
          ariaLabel="全局统计图表"
          className="global-stats-tab-control"
        />
        {tab === "usage" && (
          <SegmentedControl
            options={[
              { value: "7", label: "7 天" },
              { value: "14", label: "14 天" },
              { value: "30", label: "30 天" },
            ]}
            value={usageDays}
            onChange={setUsageDays}
            ariaLabel="用量趋势天数"
            className="global-stats-range-control"
          />
        )}
      </div>

      <div className="global-stats-tab-body">
        {tab === "usage" && (
          <GlobalDailyUsageChart accounts={accounts} statuses={statuses} days={Number(usageDays)} now={now} />
        )}
        {tab === "models" && <GlobalModelUsageChart accounts={accounts} statuses={statuses} />}
        {tab === "balance" && <GlobalBalanceTrendChart snapshots={snapshots} accounts={accounts} />}
        {tab === "cost" && <CostBreakdownChart accounts={accounts} statuses={statuses} />}
        {openAiAccounts.length > 0 && (tab === "usage" || tab === "models") && (
          <p className="chart-footnote">
            OpenAI API 请求与 Token 统计覆盖 Responses 和 Chat Completions，按 UTC 计日。
            {tab === "models" && " 模型排行使用 OpenAI API 近 30 天数据，其他站点按各自返回的时段。"}
          </p>
        )}
        {errors.map(({ key, label, message, name }) => (
          <p key={key} className="chart-footnote" role="status">{name} · {label}查询失败 · {message}</p>
        ))}
      </div>
    </section>
  );
}

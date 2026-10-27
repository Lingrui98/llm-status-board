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
}

const TAB_OPTIONS = [
  { value: "usage", label: "用量趋势" },
  { value: "models", label: "模型用量" },
  { value: "balance", label: "余额趋势" },
  { value: "cost", label: "费用构成" },
] as const;

export default function GlobalStatsCard({ accounts, statuses, snapshots }: Props) {
  const [tab, setTab] = useState<StatsTab>("usage");
  const [usageDays, setUsageDays] = useState<UsageDays>("14");

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
          <GlobalDailyUsageChart accounts={accounts} statuses={statuses} days={Number(usageDays)} />
        )}
        {tab === "models" && <GlobalModelUsageChart accounts={accounts} statuses={statuses} />}
        {tab === "balance" && <GlobalBalanceTrendChart snapshots={snapshots} accounts={accounts} />}
        {tab === "cost" && <CostBreakdownChart accounts={accounts} statuses={statuses} />}
      </div>
    </section>
  );
}

import { lazy, Suspense, type ComponentType } from "react";

/**
 * 图表懒加载：recharts（含 d3）是 bundle 最大头，但只在详情抽屉/全局统计区用到。
 * 这里统一把 recharts 图表包成 lazy 组件，把图表库拆出首屏主包。
 *
 * QuotaWindowBars 是纯 CSS 组件（不引 recharts），保持同步导入。
 * Suspense 的 fallback 用轻量占位（chunk 在本地磁盘，加载近乎瞬时，占位只是防御）。
 */

/** 懒加载占位：与图表空态同尺寸的轻量骨架 */
function ChartFallback() {
  return (
    <div className="chart-fallback" role="img" aria-label="图表加载中">
      <span className="chart-fallback-bar" />
      <span className="chart-fallback-bar short" />
      <span className="chart-fallback-bar" />
    </div>
  );
}

/** 包装：给 lazy 组件套 Suspense（props 类型经 ComponentProps 原样保留） */
function withSuspense<P extends object>(Comp: ComponentType<P>) {
  const Wrapped = (props: P) => (
    <Suspense fallback={<ChartFallback />}>
      <Comp {...props} />
    </Suspense>
  );
  Wrapped.displayName = "LazyChart";
  return Wrapped;
}

export const LazyDailyUsageChart = withSuspense(lazy(() => import("./DailyUsageChart")));
export const LazyModelUsageChart = withSuspense(lazy(() => import("./ModelUsageChart")));
export const LazyBalanceTrendChart = withSuspense(lazy(() => import("./BalanceTrendChart")));
export const LazyBalanceBreakdownChart = withSuspense(lazy(() => import("./BalanceBreakdownChart")));
export const LazyTokenSplitChart = withSuspense(lazy(() => import("./TokenSplitChart")));
export const LazyGlobalDailyUsageChart = withSuspense(lazy(() => import("./GlobalDailyUsageChart")));
export const LazyGlobalModelUsageChart = withSuspense(lazy(() => import("./GlobalModelUsageChart")));
export const LazyGlobalBalanceTrendChart = withSuspense(lazy(() => import("./GlobalBalanceTrendChart")));
export const LazyCostBreakdownChart = withSuspense(lazy(() => import("./CostBreakdownChart")));

/** pickTrendCurrency 是纯函数且已移到 shared（不引 recharts），同步导出不唤起图表 chunk */
export { pickTrendCurrency, ChartSection, ChartEmpty } from "./shared";

/**
 * R14/R15 设计系统原语统一出口。
 * 集成方（开发 A）只需：
 *   import { StatTile, MiniSparkline, ThresholdSlider, SegmentedControl } from "./components/ui";
 *   import { DeltaBadge, RankingRow, HeatStrip, MiniBars } from "./components/ui";
 */
export { default as StatTile } from "./StatTile";
export type { StatTileProps, StatTone, TrendDirection } from "./StatTile";

export { default as MiniSparkline } from "./MiniSparkline";
export type { MiniSparklineProps, SparkTone } from "./MiniSparkline";

export { default as ThresholdSlider } from "./ThresholdSlider";
export type { ThresholdSliderProps } from "./ThresholdSlider";

export { default as SegmentedControl } from "./SegmentedControl";
export type { SegmentedControlProps, SegmentedOption } from "./SegmentedControl";

/* ---------- R15：分析视图视觉原语 ---------- */

export { default as DeltaBadge } from "./DeltaBadge";
export type { DeltaBadgeProps } from "./DeltaBadge";

export { default as RankingRow } from "./RankingRow";
export type { RankingRowProps } from "./RankingRow";

export { default as HeatStrip } from "./HeatStrip";
export type { HeatStripProps, HeatStripCell } from "./HeatStrip";

export { default as MiniBars } from "./MiniBars";
export type { MiniBarsProps } from "./MiniBars";

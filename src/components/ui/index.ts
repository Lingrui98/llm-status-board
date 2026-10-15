/**
 * R14 设计系统原语统一出口。
 * 集成方（开发 A）只需：
 *   import { StatTile, MiniSparkline, ThresholdSlider, SegmentedControl } from "./components/ui";
 */
export { default as StatTile } from "./StatTile";
export type { StatTileProps, StatTone, TrendDirection } from "./StatTile";

export { default as MiniSparkline } from "./MiniSparkline";
export type { MiniSparklineProps, SparkTone } from "./MiniSparkline";

export { default as ThresholdSlider } from "./ThresholdSlider";
export type { ThresholdSliderProps } from "./ThresholdSlider";

export { default as SegmentedControl } from "./SegmentedControl";
export type { SegmentedControlProps, SegmentedOption } from "./SegmentedControl";

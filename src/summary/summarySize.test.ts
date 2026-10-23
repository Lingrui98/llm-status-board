// R24：浮层尺寸持久化纯逻辑测试 —— 钳制边界 / 读写往返 / 损坏数据回落。
import { describe, expect, it } from "vitest";
import {
  SUMMARY_DEFAULT_HEIGHT,
  SUMMARY_DEFAULT_WIDTH,
  SUMMARY_MAX_SIDE,
  SUMMARY_MIN_HEIGHT,
  SUMMARY_MIN_WIDTH,
  clampSummarySize,
  loadSummarySize,
  saveSummarySize,
} from "./summarySize";

/** 内存版 Storage 桩（jsdom 有 localStorage，但用桩断言更直接、不碰全局态） */
function memStorage(initial?: Record<string, string>) {
  const map = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    dump: () => Object.fromEntries(map),
  };
}

describe("summarySize：钳制", () => {
  it("正常尺寸原样通过（取整）", () => {
    expect(clampSummarySize(300.4, 360.6)).toEqual({ width: 300, height: 361 });
  });

  it("小于下限 → 抬到下限；大于上限 → 压到上限", () => {
    expect(clampSummarySize(100, 100)).toEqual({ width: SUMMARY_MIN_WIDTH, height: SUMMARY_MIN_HEIGHT });
    expect(clampSummarySize(5000, 5000)).toEqual({ width: SUMMARY_MAX_SIDE, height: SUMMARY_MAX_SIDE });
  });

  it("非有限值 / 0 → 默认尺寸", () => {
    expect(clampSummarySize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({
      width: SUMMARY_DEFAULT_WIDTH,
      height: SUMMARY_DEFAULT_HEIGHT,
    });
    expect(clampSummarySize(0, 0)).toEqual({ width: SUMMARY_DEFAULT_WIDTH, height: SUMMARY_DEFAULT_HEIGHT });
  });
});

describe("summarySize：读写", () => {
  it("写入→读取往返一致（先钳制）", () => {
    const s = memStorage();
    saveSummarySize(420.4, 500.6, s);
    expect(loadSummarySize(s)).toEqual({ width: 420, height: 501 });
  });

  it("无记录 / 损坏 JSON / 字段类型错 → null（回落默认）", () => {
    expect(loadSummarySize(memStorage())).toBeNull();
    expect(loadSummarySize(memStorage({ "lsb-summary-size": "{broken" }))).toBeNull();
    expect(loadSummarySize(memStorage({ "lsb-summary-size": '{"w":"x","h":300}' }))).toBeNull();
  });

  it("读取时对越界值同样钳制（手改 localStorage 也不越界）", () => {
    const s = memStorage({ "lsb-summary-size": '{"w":100,"h":5000}' });
    expect(loadSummarySize(s)).toEqual({ width: SUMMARY_MIN_WIDTH, height: SUMMARY_MAX_SIDE });
  });
});

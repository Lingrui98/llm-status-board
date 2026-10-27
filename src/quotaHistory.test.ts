import { describe, expect, it } from "vitest";
import { buildQuotaRows, latestQuotaSegment, mainSubscriptionWindow, quotaKey, scopedQuotaSamples } from "./quotaHistory";
import type { AccountInfo, QuotaBoundary, QuotaSample } from "./types";
import { formatPrimaryMetricLine, pickPrimaryMetric } from "./primaryMetric";

const start = Date.parse("2026-10-01T00:00:00Z");
function sample(offset: number, used: number, segment = 1, boundary: QuotaBoundary | null = null): QuotaSample {
  return { ts: new Date(start + offset).toISOString(), scope: "a", windows: [{ key: "codex:604800", label: "Codex · 每周", usedPercent: used,
    resetsAt: "2026-10-07T09:23:00Z", windowSeconds: 604800, segment, boundary }] };
}
const window = { from: start, to: start + 90 * 86400000 };

describe("subscription percentage history", () => {
  it("keeps a weekly-only Pro main metric separate from code review and other models", () => {
    const info: AccountInfo = { fetchedAt: "", extras: [], quotaWindows: [
      { window: "代码审查 · 每周", historyKey: "review:604800", usedPercent: 99 },
      { window: "Codex · 每周", historyKey: "codex:604800", windowSeconds: 604800, usedPercent: 60 },
    ] };
    expect(mainSubscriptionWindow(info)?.usedPercent).toBe(60);
    expect(quotaKey(mainSubscriptionWindow(info)!)).toBe("codex:604800");
    expect(formatPrimaryMetricLine(pickPrimaryMetric(info))).toBe("剩余 40%（Codex · 每周）");
    expect(mainSubscriptionWindow({ ...info, quotaWindows: info.quotaWindows?.slice(0, 1) })).toBeNull();
  });

  it("uses actual timestamp distances rather than evenly spaced sample indices", () => {
    const { rows } = buildQuotaRows([sample(0, 10), sample(60000, 20), sample(660000, 30)], "codex:604800", window);
    expect(rows[2].timestamp - rows[1].timestamp).toBe(10 * (rows[1].timestamp - rows[0].timestamp));
  });

  it("breaks at every extra reset while preserving actual post-reset usage", () => {
    const data = [sample(0, 80), sample(60000, 0, 2, "usageDecreased"), sample(120000, 10, 2), sample(180000, 2, 3, "usageDecreased")];
    const { rows, events } = buildQuotaRows(data, "codex:604800", window);
    expect(rows.map(r => r.value)).toEqual([80, null, 0, 10, null, 2]);
    expect(events.map(e => e.boundary)).toEqual(["usageDecreased", "usageDecreased"]);
    expect(latestQuotaSegment(data, "codex:604800")).toBe(3);
  });

  it("does not connect across absent windows or long offline gaps", () => {
    const missing = { ...sample(60000, 0), windows: [] };
    const { rows } = buildQuotaRows([sample(0, 10), missing, sample(120000, 20), sample(9 * 3600000, 30)], "codex:604800", window);
    expect(rows.map(r => r.value)).toEqual([10, null, 20, null, 30]);
  });

  it("filters workspaces before plotting and does not mix a re-login to another workspace", () => {
    const other = { ...sample(30000, 99), scope: "b" };
    const scoped = scopedQuotaSamples([sample(60000, 20), other, sample(0, 10)], "a");
    expect(buildQuotaRows(scoped, "codex:604800", window).rows.map(r => r.value)).toEqual([10, 20]);
  });

  it("switches to remaining percentage without fabricating monetary consumption", () => {
    const { rows } = buildQuotaRows([sample(0, 40), sample(60000, 110)], "codex:604800", window, "remaining");
    expect(rows.map(r => r.value)).toEqual([60, 0]);
    expect(rows[1].usedPercent).toBe(110);
  });

  it("never joins different runs after reducing a large chart to a bounded set of points", () => {
    const data = Array.from({ length: 150000 }, (_, i) => sample(i * 1000, i % 100, Math.floor(i / 100) + 1));
    const { rows, count } = buildQuotaRows(data, "codex:604800", window, "used", 120);
    expect(count).toBe(150000);
    expect(rows.length).toBeLessThanOrEqual(240);
    for (let i = 1; i < rows.length; i++) {
      if (rows[i - 1].value !== null && rows[i].value !== null) expect(rows[i].run).toBe(rows[i - 1].run);
    }
  });

  it("does not invent a zero at a schedule-only adjustment and respects range boundaries", () => {
    const data = [sample(0, 60), sample(60000, 60, 2, "scheduleChanged"), sample(120000, 70, 2)];
    const { rows } = buildQuotaRows(data, "codex:604800", { from: start + 60000, to: start + 120000 });
    expect(rows.map(r => r.value)).toEqual([60, 70]);
  });
});

import { describe, expect, it } from "vitest";
import type { AccountInfo, RefreshOutcome } from "./types";
import {
  DEFAULT_NOTIFY_THRESHOLDS,
  computeProblemNotifications,
  diffRecovered,
  filterActiveRecovered,
  mergeRecovered,
  problemKey,
} from "./notifications";

const NOW = "2026-10-10T12:00:00.000Z";

function makeInfo(patch: Partial<AccountInfo> = {}): AccountInfo {
  return {
    balance: null,
    used: null,
    total: null,
    requests: null,
    note: null,
    extras: [],
    raw: null,
    fetchedAt: NOW,
    ...patch,
  };
}

function okOutcome(accountId: string, info: Partial<AccountInfo> = {}): RefreshOutcome {
  return { accountId, ok: true, info: makeInfo(info), error: null };
}

const names: Record<string, string> = {};

describe("通知推导：余额不足", () => {
  it("USD/CNY 走各自阈值，credits 单位跳过", () => {
    const outcomes: RefreshOutcome[] = [
      okOutcome("a-usd-low", { balance: { amount: 0.5, currency: "USD" } }), // < 1 → 提醒
      okOutcome("b-usd-ok", { balance: { amount: 5, currency: "USD" } }), // ≥ 1 → 无
      okOutcome("c-cny-low", { balance: { amount: 5, currency: "CNY" } }), // < 7 → 提醒
      okOutcome("d-cny-ok", { balance: { amount: 10, currency: "CNY" } }), // ≥ 7 → 无
      okOutcome("e-credits", { balance: { amount: 0.01, currency: "credits" } }), // 点数单位 → 跳过
      okOutcome("f-nobalance"), // 无余额数据 → 无
    ];
    const { notifications, problemKeys } = computeProblemNotifications(outcomes, names, DEFAULT_NOTIFY_THRESHOLDS, NOW);
    expect(notifications.map((n) => n.id).sort()).toEqual(["lowBalance:a-usd-low", "lowBalance:c-cny-low"]);
    expect(notifications.every((n) => n.kind === "lowBalance" && n.severity === "warn")).toBe(true);
    expect(problemKeys.has(problemKey("lowBalance", "a-usd-low"))).toBe(true);
    expect(problemKeys.size).toBe(2);
    // 自定义阈值可覆盖默认值
    const custom = computeProblemNotifications(outcomes, names, { ...DEFAULT_NOTIFY_THRESHOLDS, lowBalanceUsd: 10 }, NOW);
    expect(custom.notifications.some((n) => n.id === "lowBalance:b-usd-ok")).toBe(true);
  });
});

describe("通知推导：刷新失败", () => {
  it("!ok 的账号生成错误通知并带错误文本，成功账号不产生通知", () => {
    const outcomes: RefreshOutcome[] = [
      { accountId: "acc-fail", ok: false, info: null, error: "HTTP 401: 无效的访问令牌" },
      okOutcome("acc-ok", { balance: { amount: 99, currency: "USD" } }),
    ];
    const { notifications, problemKeys } = computeProblemNotifications(outcomes, names, DEFAULT_NOTIFY_THRESHOLDS, NOW);
    expect(notifications).toHaveLength(1);
    const n = notifications[0];
    expect(n.kind).toBe("refreshError");
    expect(n.severity).toBe("err");
    expect(n.id).toBe("refreshError:acc-fail");
    expect(n.detail).toContain("401");
    expect(problemKeys.has("refreshError:acc-fail")).toBe(true);
  });
});

describe("通知推导：配额将满", () => {
  it("usedPercent ≥ 阈值才触发，同账号多窗口聚合为一条", () => {
    const outcomes: RefreshOutcome[] = [
      okOutcome("acc-quota", {
        quotaWindows: [
          { window: "5h 窗口", usedPercent: 92, resetsAt: null },
          { window: "周配额", usedPercent: 87, resetsAt: null },
          { window: "月配额", usedPercent: 40, resetsAt: null },
          { window: "无数据窗口", usedPercent: null, resetsAt: null },
        ],
      }),
      okOutcome("acc-boundary", { quotaWindows: [{ window: "5h", usedPercent: 85, resetsAt: null }] }), // 边界 = 85 → 触发
      okOutcome("acc-calm", { quotaWindows: [{ window: "5h", usedPercent: 84.9, resetsAt: null }] }), // 84.9 → 不触发
    ];
    const { notifications } = computeProblemNotifications(outcomes, names, DEFAULT_NOTIFY_THRESHOLDS, NOW);
    expect(notifications).toHaveLength(2);
    const q = notifications.find((n) => n.accountId === "acc-quota")!;
    expect(q.kind).toBe("quotaFull");
    // 多个越线窗口聚合在一条 detail 里，未越线的不出现
    expect(q.detail).toContain("92%");
    expect(q.detail).toContain("87%");
    expect(q.detail).not.toContain("40%");
    expect(notifications.some((n) => n.accountId === "acc-calm")).toBe(false);
  });
});

describe("通知去重", () => {
  it("同账号同类通知 id 稳定，重复计算不堆积", () => {
    const outcomes: RefreshOutcome[] = [
      okOutcome("acc-x", {
        balance: { amount: 0.2, currency: "USD" },
        quotaWindows: [{ window: "5h", usedPercent: 99, resetsAt: null }],
      }),
    ];
    const first = computeProblemNotifications(outcomes, names, DEFAULT_NOTIFY_THRESHOLDS, NOW);
    const second = computeProblemNotifications(outcomes, names, DEFAULT_NOTIFY_THRESHOLDS, NOW);
    // 同一账号可并存多种类型（余额不足 + 配额将满），但每类仅一条
    expect(first.notifications.map((n) => n.id).sort()).toEqual(["lowBalance:acc-x", "quotaFull:acc-x"]);
    expect(second.notifications.map((n) => n.id)).toEqual(first.notifications.map((n) => n.id));
    // 恢复通知合并同样按 id 去重并保留最新时间
    const t1 = { id: "recovered:refreshError:acc-x", kind: "recovered" as const, accountId: "acc-x", accountName: "acc-x", title: "已恢复", at: "2026-10-10T10:00:00.000Z", severity: "ok" as const };
    const t2 = { ...t1, at: "2026-10-10T11:00:00.000Z" };
    const merged = mergeRecovered([t1], [t2]);
    expect(merged).toHaveLength(1);
    expect(merged[0].at).toBe("2026-10-10T11:00:00.000Z");
  });
});

describe("恢复检测", () => {
  it("问题消失且账号本轮成功 → 生成「已恢复」；账号不在成功集合则静默丢弃", () => {
    const prev = new Set(["refreshError:acc-a", "lowBalance:acc-b"]);
    const cur = new Set<string>();
    const okIds = new Set(["acc-a"]); // acc-b 被删除/禁用，不算恢复
    const notes = diffRecovered(prev, cur, okIds, { "acc-a": "某账号" }, NOW);
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe("recovered:refreshError:acc-a");
    expect(notes[0].kind).toBe("recovered");
    expect(notes[0].severity).toBe("ok");
    expect(notes[0].accountName).toBe("某账号");
    // 问题复发时对应恢复通知被过滤掉
    const active = filterActiveRecovered(notes, new Set(["refreshError:acc-a"]));
    expect(active).toHaveLength(0);
  });
});

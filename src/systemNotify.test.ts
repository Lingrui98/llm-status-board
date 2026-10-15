// R16 §4 系统通知防打扰单测：只推新问题 / 24h 抑制 / 速率上限（丢弃不记账）/ 开关关闭不发。
// 全部注入 now 与 state，断言不依赖真实时间与本机时区。

import { describe, expect, it } from "vitest";
import {
  NOTIFY_BODY_MAX,
  NOTIFY_SUPPRESS_MS,
  RATE_MAX_IN_WINDOW,
  RATE_WINDOW_MS,
  SYSTEM_NOTIFY_STORAGE_KEY,
  buildNotifyBody,
  commitSystemNotify,
  emptySystemNotifyState,
  loadSystemNotifyState,
  rateCountInWindow,
  saveSystemNotifyState,
  shouldSendSystemNotification,
  truncateBody,
  type SystemNotifySource,
  type SystemNotifyState,
} from "./systemNotify";

const T0 = 1_700_000_000_000; // 固定 epoch，与时区无关

function source(patch: Partial<SystemNotifySource> = {}): SystemNotifySource {
  return {
    kind: patch.kind ?? "lowBalance",
    accountId: patch.accountId ?? "acc-1",
    accountName: patch.accountName ?? "甲账号",
    detail: patch.detail ?? "余额 0.50 USD，低于阈值 1.00 USD",
    active: patch.active ?? true,
  };
}

function decide(
  src: SystemNotifySource,
  opts: {
    now?: number;
    enabled?: boolean;
    state?: SystemNotifyState;
    prev?: ReadonlySet<string> | null;
  } = {},
) {
  return shouldSendSystemNotification(src, {
    now: opts.now ?? T0,
    enabled: opts.enabled ?? true,
    state: opts.state ?? emptySystemNotifyState(),
    prevProblemKeys: opts.prev === undefined ? new Set<string>() : opts.prev,
  });
}

describe("systemNotify：标题与正文", () => {
  it("标题取类别中文名，正文含账号名与关键数值", () => {
    const d = decide(source());
    expect(d.send).toBe(true);
    expect(d.title).toBe("余额不足");
    expect(d.body).toBe("甲账号：余额 0.50 USD，低于阈值 1.00 USD");
  });

  it("三类标题分别正确", () => {
    expect(decide(source({ kind: "quotaFull" })).title).toBe("配额将满");
    expect(decide(source({ kind: "refreshError" })).title).toBe("刷新失败");
  });

  it("AC-9：正文超过 200 字符截断并补「…」，总长 ≤ 200", () => {
    const long = "x".repeat(500);
    const d = decide(source({ detail: long }));
    expect(d.body.length).toBe(NOTIFY_BODY_MAX);
    expect(d.body.endsWith("…")).toBe(true);
    expect(truncateBody("short")).toBe("short");
    expect(truncateBody("y".repeat(200))).toHaveLength(200); // 恰好 200 不截断
    expect(truncateBody("y".repeat(201))).toHaveLength(200);
  });

  it("buildNotifyBody 在无 detail 时只给账号名", () => {
    expect(buildNotifyBody("甲账号", "")).toBe("甲账号");
    expect(buildNotifyBody("甲账号", "  ")).toBe("甲账号");
  });
});

describe("systemNotify：只推新问题（规则 1）", () => {
  it("首轮（prev=null）视为新问题 → 可发", () => {
    expect(decide(source(), { prev: null }).send).toBe(true);
  });

  it("上一轮已存在（持续存在）→ 不重复推", () => {
    const prev = new Set(["lowBalance:acc-1"]);
    const d = decide(source(), { prev });
    expect(d.send).toBe(false);
    expect(d.skipReason).toBe("notNew");
  });

  it("本轮不存在（已恢复）→ 不推", () => {
    const d = decide(source({ active: false }), { prev: null });
    expect(d.send).toBe(false);
    expect(d.skipReason).toBe("notNew");
  });

  it("recovered 类永不推送（§4 不新增类别）", () => {
    const d = decide(source({ kind: "recovered" }), { prev: null });
    expect(d.send).toBe(false);
    expect(d.skipReason).toBe("notSystemKind");
  });

  it("不同账号的同名问题互不影响", () => {
    const prev = new Set(["lowBalance:acc-1"]);
    expect(decide(source({ accountId: "acc-2" }), { prev }).send).toBe(true);
  });
});

describe("systemNotify：24h 抑制（规则 2）", () => {
  it("AC-10：间隔 23h59m 不发；满 24h 发", () => {
    const key = "lowBalance:acc-1";
    const justUnder: SystemNotifyState = { sentAt: { [key]: T0 - (NOTIFY_SUPPRESS_MS - 60_000) }, rate: [] };
    const d1 = decide(source(), { now: T0, state: justUnder, prev: null });
    expect(d1.send).toBe(false);
    expect(d1.skipReason).toBe("suppressed");

    const exactly: SystemNotifyState = { sentAt: { [key]: T0 - NOTIFY_SUPPRESS_MS }, rate: [] };
    expect(decide(source(), { now: T0, state: exactly, prev: null }).send).toBe(true);
  });

  it("抑制表按 (账号,类型) 分键：另一类型不受影响", () => {
    const state: SystemNotifyState = { sentAt: { "lowBalance:acc-1": T0 - 1000 }, rate: [] };
    expect(decide(source({ kind: "quotaFull" }), { now: T0, state, prev: null }).send).toBe(true);
  });
});

describe("systemNotify：速率上限（规则 3）", () => {
  it("AC-11：5 分钟内已发 3 条 → 第 4 条被丢弃（rateLimited）", () => {
    const state: SystemNotifyState = { sentAt: {}, rate: [T0 - 120_000, T0 - 60_000, T0] };
    expect(rateCountInWindow(state, T0)).toBe(3);
    const d = decide(source({ accountId: "acc-new" }), { now: T0, state, prev: null });
    expect(d.send).toBe(false);
    expect(d.skipReason).toBe("rateLimited");
  });

  it("AC-11：窗口内 3 条时丢弃；其中一条出窗后可再发（判定为 now − t < 300000）", () => {
    // 三次发送发生在 NOW−4min / NOW−3min / NOW−1min（三条都仍在 5 分钟窗口内）
    const NOW = T0 + 300_000;
    const state: SystemNotifyState = {
      sentAt: {},
      rate: [NOW - 240_000, NOW - 180_000, NOW - 60_000],
    };
    expect(rateCountInWindow(state, NOW)).toBe(3);
    const blocked = decide(source({ accountId: "acc-new" }), { now: NOW, state, prev: null });
    expect(blocked.send).toBe(false);
    expect(blocked.skipReason).toBe("rateLimited");
    // 丢弃后状态不变（调用方不得 commit）：不写抑制表、不计入速率
    expect(state.sentAt["lowBalance:acc-new"]).toBeUndefined();
    expect(state.rate).toHaveLength(3);

    // 2 分钟后（NOW+120s）：NOW−4min 与 NOW−3min 两条恰好出窗（差值 = 300000，不小于窗口）
    // → 窗口内只剩 1 条 → 可发
    const later = NOW + 120_000;
    expect(rateCountInWindow(state, later)).toBe(1);
    expect(decide(source({ accountId: "acc-new" }), { now: later, state, prev: null }).send).toBe(true);
  });

  it("commit 追加计数并修剪出窗条目", () => {
    const state: SystemNotifyState = { sentAt: {}, rate: [T0 - RATE_WINDOW_MS, T0 - 60_000] };
    const next = commitSystemNotify(state, "lowBalance:acc-1", T0);
    expect(next.sentAt["lowBalance:acc-1"]).toBe(T0);
    expect(next.rate).toEqual([T0 - 60_000, T0]); // 恰好出窗的被剪掉
  });

  it("commit 修剪超过 24h 的抑制键，避免表无限增长", () => {
    const state: SystemNotifyState = { sentAt: { "old:a": T0 - NOTIFY_SUPPRESS_MS - 1, "fresh:b": T0 - 1000 }, rate: [] };
    const next = commitSystemNotify(state, "lowBalance:acc-1", T0);
    expect(next.sentAt["old:a"]).toBeUndefined();
    expect(next.sentAt["fresh:b"]).toBe(T0 - 1000);
    expect(Object.keys(next.sentAt)).toHaveLength(2);
  });

  it("上限常量符合规格（3 条 / 5 分钟）", () => {
    expect(RATE_MAX_IN_WINDOW).toBe(3);
    expect(RATE_WINDOW_MS).toBe(300_000);
    expect(NOTIFY_SUPPRESS_MS).toBe(86_400_000);
  });
});

describe("systemNotify：开关关闭", () => {
  it("开关关闭 → 完全不发（也不写抑制表）；skipReason 语义为 disabled（D-1）", () => {
    const state = emptySystemNotifyState();
    const d = decide(source(), { enabled: false, state, prev: null });
    expect(d.send).toBe(false);
    expect(d.skipReason).toBe("disabled");
    expect(state.sentAt).toEqual({});
    expect(state.rate).toEqual([]);
  });
});

describe("systemNotify：状态持久化", () => {
  it("load/save 往返；损坏或缺失 → 空状态且不抛", () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
    };
    const state: SystemNotifyState = { sentAt: { "lowBalance:acc-1": T0 }, rate: [T0] };
    saveSystemNotifyState(state, storage);
    expect(mem.has(SYSTEM_NOTIFY_STORAGE_KEY)).toBe(true);
    expect(loadSystemNotifyState(storage)).toEqual(state);
  });

  it("损坏 JSON / 错误结构 / 非法值 → 归一为空状态", () => {
    const bad = (raw: string) => loadSystemNotifyState({ getItem: () => raw });
    expect(bad("not json")).toEqual(emptySystemNotifyState());
    expect(bad("[1,2,3]")).toEqual(emptySystemNotifyState());
    expect(bad('{"sentAt":"x","rate":"y"}')).toEqual(emptySystemNotifyState());
    expect(bad('{"sentAt":{"a":1,"b":"x","c":null},"rate":[1,"x",null,2]}')).toEqual({
      sentAt: { a: 1 },
      rate: [1, 2],
    });
    expect(loadSystemNotifyState({ getItem: () => null })).toEqual(emptySystemNotifyState());
  });

  it("save 抛错被吞掉（存储不可用不影响主流程）", () => {
    expect(() =>
      saveSystemNotifyState(emptySystemNotifyState(), {
        setItem: () => {
          throw new Error("quota exceeded");
        },
      }),
    ).not.toThrow();
  });
});

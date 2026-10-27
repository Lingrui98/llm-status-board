// R14 终审 D-7：补齐 AC-9 的 UI 侧校验单测。
// validateSettings 是「保存前最后一道闸」，由 SettingsView 每次 updateSettings 调用；
// 越界/非整数必须被拒并给出含字段名与中文范围的可读提示（Rust 侧 types.rs#validate_settings 是兜底）。

import { describe, expect, it } from "vitest";
import { validateSettings } from "./components/SettingsView";
import type { Settings } from "./types";

function settings(patch: Partial<Settings> = {}): Settings {
  return { autoRefreshSec: 0, refreshOnStart: false, ...patch };
}

/** 断言被拒且提示信息包含期望片段 */
function expectRejected(s: Settings, ...fragments: string[]) {
  const result = validateSettings(s);
  expect(result.ok).toBe(false);
  if (result.ok) return; // 类型收窄（上面已断言 false）
  for (const f of fragments) expect(result.message).toContain(f);
}

describe("validateSettings：越界拒绝（AC-9）", () => {
  it("quotaPercent=120 → 拒绝，提示含字段名与 1–100", () => {
    expectRejected(settings({ notifyQuotaPercent: 120 }), "配额用量提醒线", "1–100");
  });

  it("usd=10000.5 → 拒绝（超出 USD 上限）", () => {
    expectRejected(settings({ notifyLowBalanceUsd: 10000.5 }), "低余额提醒阈值（USD）", "0–10000");
  });

  it("window=2 → 拒绝（低于窗口下限 3）", () => {
    expectRejected(settings({ insightWindowDays: 2 }), "洞察统计窗口", "3–90");
  });

  it("CNY=100000.5 → 拒绝", () => {
    expectRejected(settings({ notifyLowBalanceCny: 100000.5 }), "低余额提醒阈值（CNY）", "0–100000");
  });

  it("负数与 NaN / Infinity 一律拒绝", () => {
    expectRejected(settings({ notifyLowBalanceUsd: -1 }), "低余额提醒阈值（USD）");
    expectRejected(settings({ notifyLowBalanceCny: -0.01 }), "低余额提醒阈值（CNY）");
    expectRejected(settings({ notifyLowBalanceUsd: Number.NaN }), "低余额提醒阈值（USD）");
    expectRejected(settings({ notifyLowBalanceUsd: Number.POSITIVE_INFINITY }), "低余额提醒阈值（USD）");
    expectRejected(settings({ insightWindowDays: Number.NaN }), "洞察统计窗口");
  });

  it("非整数一律拒绝（配额与窗口必须是整数）", () => {
    expectRejected(settings({ notifyQuotaPercent: 85.5 }), "配额用量提醒线", "整数");
    expectRejected(settings({ insightWindowDays: 14.5 }), "洞察统计窗口", "整数");
    expectRejected(settings({ notifyQuotaPercent: 0.5 }), "配额用量提醒线");
  });
});

describe("validateSettings：边界值通过", () => {
  it("0 / 10000（USD）→ 通过", () => {
    expect(validateSettings(settings({ notifyLowBalanceUsd: 0 }))).toEqual({ ok: true });
    expect(validateSettings(settings({ notifyLowBalanceUsd: 10000 }))).toEqual({ ok: true });
  });

  it("0 / 100000（CNY）→ 通过", () => {
    expect(validateSettings(settings({ notifyLowBalanceCny: 0 }))).toEqual({ ok: true });
    expect(validateSettings(settings({ notifyLowBalanceCny: 100000 }))).toEqual({ ok: true });
  });

  it("1 / 100（配额%）→ 通过", () => {
    expect(validateSettings(settings({ notifyQuotaPercent: 1 }))).toEqual({ ok: true });
    expect(validateSettings(settings({ notifyQuotaPercent: 100 }))).toEqual({ ok: true });
  });

  it("3 / 90（窗口天）→ 通过", () => {
    expect(validateSettings(settings({ insightWindowDays: 3 }))).toEqual({ ok: true });
    expect(validateSettings(settings({ insightWindowDays: 90 }))).toEqual({ ok: true });
  });

  it("小数阈值在范围内（USD 12.5）→ 通过", () => {
    expect(validateSettings(settings({ notifyLowBalanceUsd: 12.5 }))).toEqual({ ok: true });
  });
});

describe("validateSettings：缺省与旧配置兼容", () => {
  it("缺省 Settings（无 R14 字段）→ 通过", () => {
    expect(validateSettings(settings())).toEqual({ ok: true });
  });

  it("显式 null（Rust Option 反序列化结果）→ 视为未设置，通过", () => {
    expect(
      validateSettings(
        settings({
          notifyLowBalanceUsd: null,
          notifyLowBalanceCny: null,
          notifyQuotaPercent: null,
          insightWindowDays: null,
        }),
      ),
    ).toEqual({ ok: true });
  });

  it("notifyEnabled 不参与校验（布尔开关无越界概念）", () => {
    expect(validateSettings(settings({ notifyEnabled: true }))).toEqual({ ok: true });
    expect(validateSettings(settings({ notifyEnabled: false }))).toEqual({ ok: true });
  });

  it("更新渠道只接受 stable / nightly", () => {
    expect(validateSettings(settings({ updateChannel: "stable" }))).toEqual({ ok: true });
    expect(validateSettings(settings({ updateChannel: "nightly" }))).toEqual({ ok: true });
    expectRejected(settings({ updateChannel: "beta" as never }), "更新渠道", "stable / nightly");
  });

  it("其它字段越界不影响 R14 校验结果（仅校验 R14 阈值）", () => {
    expect(validateSettings(settings({ autoRefreshSec: -5 }))).toEqual({ ok: true });
  });
});

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeQuotaSamples, useQuotaHistory } from "./useQuotaHistory";
import * as api from "./api";
import type { QuotaSample } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ confirm: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock("./api", () => ({ getQuotaHistory: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());
const ts = (hour: number) => `2026-10-01T0${hour}:00:00Z`;
const sample = (scope: string, timestamp = ts(0)): QuotaSample => ({ ts: timestamp, scope, windows: [] });

describe("quota history API cursor", () => {
  it("passes an omitted initial cursor and an explicit incremental cursor to Tauri", async () => {
    const actual = await vi.importActual<typeof import("./api")>("./api");
    vi.mocked(invoke).mockResolvedValue([]);

    await actual.getQuotaHistory("account", "workspace");
    expect(invoke).toHaveBeenLastCalledWith("get_quota_history", { accountId: "account", scope: "workspace", since: undefined });

    await actual.getQuotaHistory("account", "workspace", ts(2));
    expect(invoke).toHaveBeenLastCalledWith("get_quota_history", { accountId: "account", scope: "workspace", since: ts(2) });
  });
});

describe("quota history cache retention", () => {
  it("removes samples over 90 days old and enforces the configured cap", () => {
    const recent = sample("workspace", ts(0));
    expect(mergeQuotaSamples([sample("workspace", "2026-06-01T00:00:00Z")], [recent], "workspace")).toEqual([recent]);
    expect(mergeQuotaSamples([sample("workspace", ts(0)), sample("workspace", ts(1))], [sample("workspace", ts(2))], "workspace", 2)
      .map(s => s.ts)).toEqual([ts(1), ts(2)]);
  });

  it("keeps distinct sub-millisecond timestamps in their original order", () => {
    const first = sample("workspace", "2026-10-01T00:00:00.000000001Z");
    const second = sample("workspace", "2026-10-01T00:00:00.000000002Z");
    const third = sample("workspace", "2026-10-01T00:00:00.000000003Z");
    expect(mergeQuotaSamples([first, second], [third], "workspace")).toEqual([first, second, third]);
  });
});

describe("quota history workspace isolation", () => {
  it("clears the previous workspace immediately and ignores late requests after switching", async () => {
    let resolveOld!: (data: QuotaSample[]) => void;
    vi.mocked(api.getQuotaHistory).mockImplementation((_, scope) => scope === "old"
      ? new Promise(resolve => { resolveOld = resolve; }) : Promise.resolve([sample("new"), sample("other")]));
    const { result, rerender } = renderHook(({ scope }) => useQuotaHistory("account", scope, "stamp"), { initialProps: { scope: "old" } });
    rerender({ scope: "new" });
    expect(result.current.samples).toEqual([]);
    await waitFor(() => expect(result.current.samples).toEqual([sample("new")]));
    await act(async () => resolveOld([sample("old")]));
    expect(result.current.samples).toEqual([sample("new")]);
  });

  it("uses the latest timestamp as since and merges sorted, deduplicated increments", async () => {
    const oldest = sample("workspace", ts(0));
    const latest = sample("workspace", ts(2));
    vi.mocked(api.getQuotaHistory)
      .mockResolvedValueOnce([latest, sample("other", ts(3)), oldest])
      .mockResolvedValueOnce([sample("workspace", ts(4)), latest, sample("workspace", ts(3))]);
    const { result, rerender } = renderHook(({ stamp }) => useQuotaHistory("account", "workspace", stamp), { initialProps: { stamp: "first" } });

    await waitFor(() => expect(result.current.samples.map(s => s.ts)).toEqual([ts(0), ts(2)]));
    expect(api.getQuotaHistory).toHaveBeenNthCalledWith(1, "account", "workspace", undefined);

    rerender({ stamp: "next" });
    expect(api.getQuotaHistory).toHaveBeenNthCalledWith(2, "account", "workspace", ts(2));
    await waitFor(() => expect(result.current.samples.map(s => s.ts)).toEqual([ts(0), ts(2), ts(3), ts(4)]));
    expect(result.current.samples).toContainEqual(oldest);
    expect(result.current.samples).toContainEqual(latest);
    expect(result.current.error).toBeNull();
    expect(api.getQuotaHistory).toHaveBeenCalledTimes(2);
  });

  it("preserves readable history on an IO error while exposing the failure", async () => {
    vi.mocked(api.getQuotaHistory).mockResolvedValue([sample("workspace")]);
    const { result, rerender } = renderHook(({ stamp }) => useQuotaHistory("account", "workspace", stamp), { initialProps: { stamp: "first" } });
    await waitFor(() => expect(result.current.samples).toHaveLength(1));
    vi.mocked(api.getQuotaHistory).mockRejectedValue("历史读取失败");
    rerender({ stamp: "next" });
    await waitFor(() => expect(result.current.error).toBe("历史读取失败"));
    expect(result.current.samples).toHaveLength(1);
  });
});

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuotaHistory } from "./useQuotaHistory";
import * as api from "./api";
import type { QuotaSample } from "./types";

vi.mock("./api", () => ({ getQuotaHistory: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());
const sample = (scope: string): QuotaSample => ({ ts: "2026-10-01T00:00:00Z", scope, windows: [] });

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

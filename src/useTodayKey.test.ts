import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useTodayKey } from "./useTodayKey";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useTodayKey", () => {
  it("跨午夜后无需刷新账号也会更新日期", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 23, 59, 30));
    const { result } = renderHook(() => useTodayKey());
    expect(result.current.todayKey).toBe("2026-10-27");

    act(() => {
      vi.setSystemTime(new Date(2026, 9, 28, 0, 0, 0));
      vi.advanceTimersByTime(60_000);
    });
    expect(result.current.todayKey).toBe("2026-10-28");
  });
});

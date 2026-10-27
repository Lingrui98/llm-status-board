import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useTheme } from "./useTheme";
import type { Settings } from "./types";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete document.documentElement.dataset.theme;
});

function systemMedia(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  const media = {
    get matches() { return dark; },
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
  return {
    setDark(next: boolean) {
      dark = next;
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

describe("useTheme", () => {
  it("立即应用固定主题，并在配置变化时更新", () => {
    systemMedia(false);
    const settings = { themeMode: "dark" } as Settings;
    const { rerender } = renderHook(({ value }) => useTheme(value), {
      initialProps: { value: settings },
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    rerender({ value: { ...settings, themeMode: "light" } as Settings });
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("跟随系统偏好变化，并在固定时间切换后复查", () => {
    const media = systemMedia(false);
    const { unmount } = renderHook(() => useTheme({ themeMode: "system" } as Settings));
    expect(document.documentElement.dataset.theme).toBe("light");
    media.setDark(true);
    expect(document.documentElement.dataset.theme).toBe("dark");
    unmount();

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 27, 18, 59, 0));
    systemMedia(false);
    renderHook(() => useTheme({ themeMode: "scheduled", themeLightTime: "07:00", themeDarkTime: "19:00" } as Settings));
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => {
      vi.setSystemTime(new Date(2026, 9, 27, 19, 0, 0));
      vi.advanceTimersByTime(30_000);
    });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

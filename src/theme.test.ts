import { afterEach, describe, expect, it, vi } from "vitest";
import {
  calculateSunTimes,
  DEFAULT_THEME_DARK_TIME,
  DEFAULT_THEME_LATITUDE,
  DEFAULT_THEME_LIGHT_TIME,
  DEFAULT_THEME_LONGITUDE,
  DEFAULT_THEME_MODE,
  DEFAULT_THEME_SETTINGS,
  getSystemTheme,
  isThemeMode,
  isValidThemeLatitude,
  isValidThemeLongitude,
  isValidThemeTime,
  resolveThemeMode,
  resolveThemeSettings,
  THEME_MODES,
  validateThemeSettings,
  type ThemeSettings,
} from "./theme";

function localDate(hour = 12, minute = 0, second = 0): Date {
  return new Date(2026, 5, 21, hour, minute, second, 0);
}

function circularMinuteDifference(a: number, b: number): number {
  const difference = Math.abs(a - b) % 1440;
  return Math.min(difference, 1440 - difference);
}

/** NOAA 返回本地墙上时间。测试先把期望 UTC 时刻换成本机时区。 */
function expectUtcTimeAsLocal(actual: Date, utcMinutes: number, reference: Date, tolerance: number) {
  const expectedLocal = ((utcMinutes - reference.getTimezoneOffset()) % 1440 + 1440) % 1440;
  const actualMinutes = actual.getHours() * 60 + actual.getMinutes() + actual.getSeconds() / 60;
  expect(circularMinuteDifference(actualMinutes, expectedLocal)).toBeLessThanOrEqual(tolerance);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("主题默认值与设置解析", () => {
  it("提供稳定的默认值", () => {
    expect(DEFAULT_THEME_MODE).toBe("system");
    expect(DEFAULT_THEME_LIGHT_TIME).toBe("07:00");
    expect(DEFAULT_THEME_DARK_TIME).toBe("19:00");
    expect(DEFAULT_THEME_LATITUDE).toBe(0);
    expect(DEFAULT_THEME_LONGITUDE).toBe(0);
    expect(DEFAULT_THEME_SETTINGS).toEqual({
      themeMode: "system",
      themeLightTime: "07:00",
      themeDarkTime: "19:00",
      themeLatitude: 0,
      themeLongitude: 0,
    });
  });

  it("旧配置和 null 字段使用默认值", () => {
    expect(resolveThemeSettings()).toEqual(DEFAULT_THEME_SETTINGS);
    expect(resolveThemeSettings(null)).toEqual(DEFAULT_THEME_SETTINGS);
    expect(
      resolveThemeSettings({
        themeMode: null,
        themeLightTime: null,
        themeDarkTime: null,
        themeLatitude: null,
        themeLongitude: null,
      }),
    ).toEqual(DEFAULT_THEME_SETTINGS);
  });

  it("保留合法值并逐字段回退非法值", () => {
    expect(
      resolveThemeSettings({
        themeMode: "scheduled",
        themeLightTime: "06:15",
        themeDarkTime: "20:45",
        themeLatitude: 31.2304,
        themeLongitude: 121.4737,
      }),
    ).toEqual({
      themeMode: "scheduled",
      themeLightTime: "06:15",
      themeDarkTime: "20:45",
      themeLatitude: 31.2304,
      themeLongitude: 121.4737,
    });

    expect(
      resolveThemeSettings({
        themeMode: "invalid" as never,
        themeLightTime: "7:00",
        themeDarkTime: "24:00",
        themeLatitude: Number.NaN,
        themeLongitude: 181,
      }),
    ).toEqual(DEFAULT_THEME_SETTINGS);
  });
});

describe("主题字段校验", () => {
  it("模式白名单与五个公开选项一致", () => {
    expect(THEME_MODES).toEqual(["dark", "light", "system", "scheduled", "sunrise"]);
    for (const mode of THEME_MODES) expect(isThemeMode(mode)).toBe(true);
    for (const mode of ["", "auto", "System", " sunrise", "sunrise ", null, 1]) {
      expect(isThemeMode(mode)).toBe(false);
    }
  });

  it("时间只接受严格的 24 小时制 HH:mm", () => {
    for (const value of ["00:00", "00:01", "07:00", "19:30", "23:59"]) {
      expect(isValidThemeTime(value)).toBe(true);
    }
    for (const value of [
      "",
      "7:00",
      "07:0",
      "24:00",
      "23:60",
      "12:00:00",
      " 07:00",
      "07:00 ",
      "ab:cd",
      null,
      700,
    ]) {
      expect(isValidThemeTime(value)).toBe(false);
    }
  });

  it("经纬度检查有限数字和闭区间边界", () => {
    for (const value of [-90, -31.2, 0, 90]) expect(isValidThemeLatitude(value)).toBe(true);
    for (const value of [-90.001, 90.001, Number.NaN, Number.POSITIVE_INFINITY, "0", null]) {
      expect(isValidThemeLatitude(value)).toBe(false);
    }
    for (const value of [-180, -121.4, 0, 180]) expect(isValidThemeLongitude(value)).toBe(true);
    for (const value of [-180.001, 180.001, Number.NaN, Number.NEGATIVE_INFINITY, "0", null]) {
      expect(isValidThemeLongitude(value)).toBe(false);
    }
  });

  it("旧配置、显式 null 和全部合法字段通过校验", () => {
    expect(validateThemeSettings()).toEqual({ ok: true });
    expect(validateThemeSettings({})).toEqual({ ok: true });
    expect(
      validateThemeSettings({
        themeMode: null,
        themeLightTime: null,
        themeDarkTime: null,
        themeLatitude: null,
        themeLongitude: null,
      }),
    ).toEqual({ ok: true });
    expect(
      validateThemeSettings({
        themeMode: "sunrise",
        themeLightTime: "06:00",
        themeDarkTime: "18:00",
        themeLatitude: -90,
        themeLongitude: 180,
      }),
    ).toEqual({ ok: true });
  });

  it("非法字段返回包含字段名的中文错误", () => {
    const cases: Array<[ThemeSettings, string]> = [
      [{ themeMode: "auto" as never }, "主题模式"],
      [{ themeLightTime: "7:00" }, "浅色主题开始时间"],
      [{ themeDarkTime: "24:00" }, "深色主题开始时间"],
      [{ themeLatitude: 91 }, "纬度"],
      [{ themeLatitude: Number.NaN }, "纬度"],
      [{ themeLongitude: -181 }, "经度"],
      [{ themeLongitude: Number.POSITIVE_INFINITY }, "经度"],
    ];
    for (const [settings, fragment] of cases) {
      const result = validateThemeSettings(settings);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain(fragment);
    }
  });
});

describe("固定模式和跟随系统", () => {
  it("深色与浅色模式不受时间影响", () => {
    expect(resolveThemeMode({ themeMode: "dark" }, localDate(), "light")).toBe("dark");
    expect(resolveThemeMode({ themeMode: "light" }, localDate(), "dark")).toBe("light");
    expect(resolveThemeMode({ themeMode: "dark" }, new Date(Number.NaN), "light")).toBe("dark");
  });

  it("system 使用注入的系统主题，缺省模式也是 system", () => {
    expect(resolveThemeMode({ themeMode: "system" }, localDate(), "dark")).toBe("dark");
    expect(resolveThemeMode({ themeMode: "system" }, localDate(), "light")).toBe("light");
    expect(resolveThemeMode({}, localDate(), "dark")).toBe("dark");
    expect(resolveThemeMode(null, localDate(), "light")).toBe("light");
  });

  it("getSystemTheme 读取系统偏好并在不可用时返回浅色", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    expect(getSystemTheme()).toBe("dark");
    expect(globalThis.matchMedia).toHaveBeenCalledWith("(prefers-color-scheme: dark)");

    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
    expect(getSystemTheme()).toBe("light");

    vi.stubGlobal("matchMedia", undefined);
    expect(getSystemTheme()).toBe("light");
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => {
        throw new Error("unsupported");
      }),
    );
    expect(getSystemTheme()).toBe("light");
  });
});

describe("固定时间模式", () => {
  const settings: ThemeSettings = {
    themeMode: "scheduled",
    themeLightTime: "07:00",
    themeDarkTime: "19:00",
  };

  it("普通日内区间包含浅色起点，不包含深色起点", () => {
    expect(resolveThemeMode(settings, localDate(6, 59), "light")).toBe("dark");
    expect(resolveThemeMode(settings, localDate(7, 0), "dark")).toBe("light");
    expect(resolveThemeMode(settings, localDate(18, 59, 59), "dark")).toBe("light");
    expect(resolveThemeMode(settings, localDate(19, 0), "light")).toBe("dark");
    expect(resolveThemeMode(settings, localDate(23, 30), "light")).toBe("dark");
  });

  it("支持浅色时段跨午夜", () => {
    const overnight: ThemeSettings = {
      themeMode: "scheduled",
      themeLightTime: "20:00",
      themeDarkTime: "06:00",
    };
    expect(resolveThemeMode(overnight, localDate(19, 59), "light")).toBe("dark");
    expect(resolveThemeMode(overnight, localDate(20, 0), "dark")).toBe("light");
    expect(resolveThemeMode(overnight, localDate(23, 59), "dark")).toBe("light");
    expect(resolveThemeMode(overnight, localDate(0, 0), "dark")).toBe("light");
    expect(resolveThemeMode(overnight, localDate(5, 59), "dark")).toBe("light");
    expect(resolveThemeMode(overnight, localDate(6, 0), "light")).toBe("dark");
    expect(resolveThemeMode(overnight, localDate(12, 0), "light")).toBe("dark");
  });

  it("缺失时间使用 07:00 和 19:00", () => {
    expect(resolveThemeMode({ themeMode: "scheduled" }, localDate(6, 59), "light")).toBe("dark");
    expect(resolveThemeMode({ themeMode: "scheduled" }, localDate(7, 0), "dark")).toBe("light");
    expect(resolveThemeMode({ themeMode: "scheduled" }, localDate(19, 0), "light")).toBe("dark");
  });

  it("相同切换时刻保持浅色", () => {
    const equal: ThemeSettings = {
      themeMode: "scheduled",
      themeLightTime: "08:00",
      themeDarkTime: "08:00",
    };
    expect(resolveThemeMode(equal, localDate(0, 0), "dark")).toBe("light");
    expect(resolveThemeMode(equal, localDate(8, 0), "dark")).toBe("light");
    expect(resolveThemeMode(equal, localDate(23, 0), "dark")).toBe("light");
  });

  it("非法时间、非法模式和非法日期退回系统主题", () => {
    expect(
      resolveThemeMode({ ...settings, themeLightTime: "7:00" }, localDate(), "dark"),
    ).toBe("dark");
    expect(resolveThemeMode({ ...settings, themeDarkTime: "24:00" }, localDate(), "light")).toBe(
      "light",
    );
    expect(resolveThemeMode({ themeMode: "bad" as never }, localDate(), "dark")).toBe("dark");
    expect(resolveThemeMode(settings, new Date(Number.NaN), "dark")).toBe("dark");
  });
});

describe("NOAA 日出日落计算", () => {
  it("北京夏至的日出日落接近期望时刻", () => {
    const date = localDate();
    const result = calculateSunTimes(date, 39.9042, 116.4074);
    expect(result.kind).toBe("regular");
    if (result.kind !== "regular") return;

    // 北京 2026-06-21 的近似值：日出 04:46，日落 19:47（UTC+8）。
    expectUtcTimeAsLocal(result.sunrise, 20 * 60 + 46, date, 8);
    expectUtcTimeAsLocal(result.sunset, 11 * 60 + 47, date, 8);
    expect(result.sunset.getTime()).toBeGreaterThan(result.sunrise.getTime());
  });

  it("格林尼治春分保持约十二小时的昼长", () => {
    const date = new Date(2026, 2, 20, 12, 0, 0, 0);
    const result = calculateSunTimes(date, 51.5074, 0);
    expect(result.kind).toBe("regular");
    if (result.kind !== "regular") return;

    const daylightHours = (result.sunset.getTime() - result.sunrise.getTime()) / 3_600_000;
    expect(daylightHours).toBeGreaterThan(11.8);
    expect(daylightHours).toBeLessThan(12.4);
    expectUtcTimeAsLocal(result.sunrise, 6 * 60 + 4, date, 12);
    expectUtcTimeAsLocal(result.sunset, 18 * 60 + 10, date, 12);
  });

  it("DST 日的太阳事件使用固定 UTC 时间戳", () => {
    const date = new Date(2026, 2, 8, 12, 0, 0, 0);
    const result = calculateSunTimes(date, 50.0755, 14.4378);
    expect(result.kind).toBe("regular");
    if (result.kind !== "regular") return;
    const expectedUtc = Date.UTC(2026, 2, 8, 5, 33, 22);
    expect(Math.abs(result.sunrise.getTime() - expectedUtc)).toBeLessThanOrEqual(60_000);
  });

  it("识别北极极昼和极夜", () => {
    expect(calculateSunTimes(localDate(), 90, 0).kind).toBe("polarDay");
    expect(calculateSunTimes(new Date(2026, 11, 21, 12), 90, 0).kind).toBe("polarNight");
    expect(calculateSunTimes(localDate(), 78.5, 15).kind).toBe("polarDay");
    expect(calculateSunTimes(new Date(2026, 11, 21, 12), 78.5, 15).kind).toBe("polarNight");
  });

  it("识别南极与北极相反的季节状态", () => {
    expect(calculateSunTimes(localDate(), -90, 0).kind).toBe("polarNight");
    expect(calculateSunTimes(new Date(2026, 11, 21, 12), -90, 0).kind).toBe("polarDay");
  });

  it("非法坐标和非法日期返回 invalid，不抛出异常", () => {
    const date = localDate();
    expect(calculateSunTimes(date, -91, 0).kind).toBe("invalid");
    expect(calculateSunTimes(date, 91, 0).kind).toBe("invalid");
    expect(calculateSunTimes(date, Number.NaN, 0).kind).toBe("invalid");
    expect(calculateSunTimes(date, 0, 181).kind).toBe("invalid");
    expect(calculateSunTimes(date, 0, Number.POSITIVE_INFINITY).kind).toBe("invalid");
    expect(calculateSunTimes(new Date(Number.NaN), 0, 0).kind).toBe("invalid");
  });
});

describe("日出日落模式解析", () => {
  const settings: ThemeSettings = {
    themeMode: "sunrise",
    themeLatitude: 39.9042,
    themeLongitude: 116.4074,
  };

  it("日出起使用浅色，日落后使用深色", () => {
    const noon = localDate();
    const times = calculateSunTimes(noon, 39.9042, 116.4074);
    expect(times.kind).toBe("regular");
    if (times.kind !== "regular") return;

    expect(resolveThemeMode(settings, new Date(times.sunrise.getTime() - 1), "light")).toBe("dark");
    expect(resolveThemeMode(settings, times.sunrise, "dark")).toBe("light");
    const middleOfDay = new Date((times.sunrise.getTime() + times.sunset.getTime()) / 2);
    expect(resolveThemeMode(settings, middleOfDay, "dark")).toBe("light");
    expect(resolveThemeMode(settings, new Date(times.sunset.getTime() - 1), "dark")).toBe("light");
    expect(resolveThemeMode(settings, times.sunset, "light")).toBe("dark");
  });

  it("远端地点跨过本机午夜时仍按最近事件切换", () => {
    const date = new Date(2026, 2, 20, 12);
    const remote: ThemeSettings = {
      themeMode: "sunrise",
      themeLatitude: 51.5074,
      themeLongitude: 0,
    };
    const times = calculateSunTimes(date, 51.5074, 0);
    expect(times.kind).toBe("regular");
    if (times.kind !== "regular") return;

    expect(resolveThemeMode(remote, new Date(times.sunrise.getTime() - 1), "light")).toBe("dark");
    expect(resolveThemeMode(remote, times.sunrise, "dark")).toBe("light");
    const middleOfDay = new Date((times.sunrise.getTime() + times.sunset.getTime()) / 2);
    expect(resolveThemeMode(remote, middleOfDay, "dark")).toBe("light");
    expect(resolveThemeMode(remote, times.sunset, "light")).toBe("dark");
  });

  it("极昼保持浅色，极夜保持深色", () => {
    expect(resolveThemeMode({ themeMode: "sunrise", themeLatitude: 90 }, localDate(), "dark")).toBe(
      "light",
    );
    expect(
      resolveThemeMode(
        { themeMode: "sunrise", themeLatitude: 90 },
        new Date(2026, 11, 21, 12),
        "light",
      ),
    ).toBe("dark");
  });

  it("极昼或极夜结束后的首个常规日延续前一极态", () => {
    const cases = [
      { latitude: 65.75, start: new Date(2026, 5, 21, 0, 0), polar: "polarDay", theme: "light", system: "dark" },
      { latitude: 68, start: new Date(2026, 11, 21, 0, 0), polar: "polarNight", theme: "dark", system: "light" },
    ] as const;
    for (const testCase of cases) {
      const settings: ThemeSettings = { themeMode: "sunrise", themeLatitude: testCase.latitude, themeLongitude: 0 };
      let verified = false;
      for (let offset = 1; offset <= 80 && !verified; offset += 1) {
        const current = new Date(testCase.start.getTime());
        current.setDate(current.getDate() + offset);
        const previous = new Date(current.getTime());
        previous.setDate(previous.getDate() - 1);
        if (
          calculateSunTimes(current, testCase.latitude, 0).kind === "regular" &&
          calculateSunTimes(previous, testCase.latitude, 0).kind === testCase.polar
        ) {
          expect(resolveThemeMode(settings, current, testCase.system)).toBe(testCase.theme);
          verified = true;
        }
      }
      expect(verified, testCase.polar).toBe(true);
    }
  });

  it("远端地点需要本机前天的事件时仍保持正确的日出前主题", () => {
    const honolulu: ThemeSettings = {
      themeMode: "sunrise",
      themeLatitude: 21.3,
      themeLongitude: -157.8,
    };
    const beforeSunrise = new Date("2025-12-31T16:00:00Z");
    expect(resolveThemeMode(honolulu, beforeSunrise, "light")).toBe("dark");
  });

  it("缺失坐标使用默认值，非法坐标和日期退回系统主题", () => {
    const noon = localDate();
    const expectedTimes = calculateSunTimes(noon, 0, 0);
    expect(expectedTimes.kind).toBe("regular");
    if (expectedTimes.kind === "regular") {
      const middleOfDay = new Date((expectedTimes.sunrise.getTime() + expectedTimes.sunset.getTime()) / 2);
      expect(resolveThemeMode({ themeMode: "sunrise" }, middleOfDay, "dark")).toBe("light");
    }

    expect(resolveThemeMode({ ...settings, themeLatitude: 91 }, noon, "dark")).toBe("dark");
    expect(resolveThemeMode({ ...settings, themeLongitude: Number.NaN }, noon, "light")).toBe(
      "light",
    );
    expect(resolveThemeMode(settings, new Date(Number.NaN), "dark")).toBe("dark");
  });
});

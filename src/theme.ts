/**
 * 主题设置、运行时解析和前端校验。
 * 本模块不读取应用配置，也不修改文档样式。
 */

export const THEME_MODES = ["dark", "light", "system", "scheduled", "sunrise"] as const;

export type ThemeMode = (typeof THEME_MODES)[number];
export type ResolvedTheme = "dark" | "light";

/** Settings 中与主题有关的字段。Settings 可直接传入此接口。 */
export interface ThemeSettings {
  themeMode?: ThemeMode | null;
  themeLightTime?: string | null;
  themeDarkTime?: string | null;
  themeLatitude?: number | null;
  themeLongitude?: number | null;
}

export interface ThemeValues {
  themeMode: ThemeMode;
  themeLightTime: string;
  themeDarkTime: string;
  themeLatitude: number;
  themeLongitude: number;
}

export const DEFAULT_THEME_MODE: ThemeMode = "system";
export const DEFAULT_THEME_LIGHT_TIME = "07:00";
export const DEFAULT_THEME_DARK_TIME = "19:00";
export const DEFAULT_THEME_LATITUDE = 0;
export const DEFAULT_THEME_LONGITUDE = 0;

export const DEFAULT_THEME_SETTINGS: Readonly<ThemeValues> = {
  themeMode: DEFAULT_THEME_MODE,
  themeLightTime: DEFAULT_THEME_LIGHT_TIME,
  themeDarkTime: DEFAULT_THEME_DARK_TIME,
  themeLatitude: DEFAULT_THEME_LATITUDE,
  themeLongitude: DEFAULT_THEME_LONGITUDE,
};

export type ThemeValidationResult = { ok: true } | { ok: false; message: string };

export type SunTimesResult =
  | { kind: "regular"; sunrise: Date; sunset: Date }
  | { kind: "polarDay" }
  | { kind: "polarNight" }
  | { kind: "invalid" };

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

export function isThemeMode(value: unknown): value is ThemeMode {
  return typeof value === "string" && (THEME_MODES as readonly string[]).includes(value);
}

/** 仅接受时间输入框使用的 24 小时制 HH:mm。 */
export function isValidThemeTime(value: unknown): value is string {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

export function isValidThemeLatitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -90 && value <= 90;
}

export function isValidThemeLongitude(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= -180 && value <= 180;
}

/**
 * 校验全部已提供的主题字段。null 和 undefined 表示使用默认值。
 * SettingsView 可将此函数并入现有 validateSettings。
 */
export function validateThemeSettings(settings?: ThemeSettings | null): ThemeValidationResult {
  const mode = settings?.themeMode;
  if (mode != null && !isThemeMode(mode)) {
    return { ok: false, message: "主题模式只支持 dark / light / system / scheduled / sunrise" };
  }

  const lightTime = settings?.themeLightTime;
  if (lightTime != null && !isValidThemeTime(lightTime)) {
    return { ok: false, message: "浅色主题开始时间必须使用 24 小时制 HH:mm" };
  }

  const darkTime = settings?.themeDarkTime;
  if (darkTime != null && !isValidThemeTime(darkTime)) {
    return { ok: false, message: "深色主题开始时间必须使用 24 小时制 HH:mm" };
  }

  const latitude = settings?.themeLatitude;
  if (latitude != null && !isValidThemeLatitude(latitude)) {
    return { ok: false, message: "纬度必须是 -90–90 之间的有效数字" };
  }

  const longitude = settings?.themeLongitude;
  if (longitude != null && !isValidThemeLongitude(longitude)) {
    return { ok: false, message: "经度必须是 -180–180 之间的有效数字" };
  }

  return { ok: true };
}

/** 将缺省或非法字段替换为默认值，供设置表单和集成层使用。 */
export function resolveThemeSettings(settings?: ThemeSettings | null): ThemeValues {
  return {
    themeMode: isThemeMode(settings?.themeMode) ? settings.themeMode : DEFAULT_THEME_MODE,
    themeLightTime: isValidThemeTime(settings?.themeLightTime)
      ? settings.themeLightTime
      : DEFAULT_THEME_LIGHT_TIME,
    themeDarkTime: isValidThemeTime(settings?.themeDarkTime)
      ? settings.themeDarkTime
      : DEFAULT_THEME_DARK_TIME,
    themeLatitude: isValidThemeLatitude(settings?.themeLatitude)
      ? settings.themeLatitude
      : DEFAULT_THEME_LATITUDE,
    themeLongitude: isValidThemeLongitude(settings?.themeLongitude)
      ? settings.themeLongitude
      : DEFAULT_THEME_LONGITUDE,
  };
}

/** 读取操作系统的深色偏好。无法读取时返回浅色。 */
export function getSystemTheme(): ResolvedTheme {
  try {
    if (typeof globalThis.matchMedia === "function") {
      return globalThis.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
  } catch {
    // 某些 WebView 可能禁用 matchMedia。此时使用浅色兜底。
  }
  return "light";
}

function minutesFromTime(value: string): number {
  return Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
}

function isValidDate(value: Date): boolean {
  return Number.isFinite(value.getTime());
}

function utcDayNumber(year: number, monthIndex: number, day: number): number {
  const value = new Date(0);
  value.setUTCHours(0, 0, 0, 0);
  value.setUTCFullYear(year, monthIndex, day);
  return value.getTime();
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/**
 * 使用 NOAA 的近似太阳位置公式计算本机日历日的日出和日落。
 * 经纬度采用 WGS84 十进制度。返回的 Date 使用本机时区显示。
 * 极昼和极夜没有日出日落时刻，因此返回独立状态。
 */
export function calculateSunTimes(
  date: Date,
  latitude: number,
  longitude: number,
): SunTimesResult {
  if (!isValidDate(date) || !isValidThemeLatitude(latitude) || !isValidThemeLongitude(longitude)) {
    return { kind: "invalid" };
  }

  const year = date.getFullYear();
  const month = date.getMonth();
  const day = date.getDate();
  const yearStart = utcDayNumber(year, 0, 1);
  const currentDay = utcDayNumber(year, month, day);
  const dayOfYear = Math.round((currentDay - yearStart) / MS_PER_DAY) + 1;
  const daysInYear = isLeapYear(year) ? 366 : 365;

  // NOAA fractional year，取当地正午。等式时间和太阳赤纬只需日级精度。
  const gamma = ((2 * Math.PI) / daysInYear) * (dayOfYear - 1);
  const equationOfTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const declination =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  const latitudeRad = latitude * DEG_TO_RAD;
  const zenithRad = 90.833 * DEG_TO_RAD;
  const denominator = Math.cos(latitudeRad) * Math.cos(declination);
  const cosHourAngle =
    (Math.cos(zenithRad) - Math.sin(latitudeRad) * Math.sin(declination)) / denominator;

  if (!Number.isFinite(cosHourAngle)) {
    // 极点处分母为零。用正午太阳高度判断全天状态。
    const declinationDeg = declination * RAD_TO_DEG;
    const noonElevation = 90 - Math.abs(latitude - declinationDeg);
    return { kind: noonElevation >= -0.833 ? "polarDay" : "polarNight" };
  }
  if (cosHourAngle >= 1) return { kind: "polarNight" };
  if (cosHourAngle <= -1) return { kind: "polarDay" };

  const hourAngleDeg = Math.acos(cosHourAngle) * RAD_TO_DEG;
  const sunriseUtcMinutes = 720 - 4 * (longitude + hourAngleDeg) - equationOfTime;
  const sunsetUtcMinutes = 720 - 4 * (longitude - hourAngleDeg) - equationOfTime;

  // NOAA 分钟数以计算日期的 UTC 零点为基准。直接使用 UTC 时间戳，
  // 避免本机夏令时在事件日和中午采用不同偏移。
  const sunrise = new Date(currentDay + Math.round(sunriseUtcMinutes * 60 * 1000));
  const sunset = new Date(currentDay + Math.round(sunsetUtcMinutes * 60 * 1000));

  if (!isValidDate(sunrise) || !isValidDate(sunset)) return { kind: "invalid" };
  return { kind: "regular", sunrise, sunset };
}

/**
 * 解析当前实际主题。第三个参数便于集成层注入系统主题，也便于确定性测试。
 * 动态模式的配置或日期非法时退回系统主题。缺失字段使用默认值。
 */
export function resolveThemeMode(
  settings?: ThemeSettings | null,
  now: Date = new Date(),
  systemTheme: ResolvedTheme = getSystemTheme(),
): ResolvedTheme {
  const resolvedSystemTheme: ResolvedTheme = systemTheme === "dark" ? "dark" : "light";
  const rawMode = settings?.themeMode ?? DEFAULT_THEME_MODE;
  if (!isThemeMode(rawMode)) return resolvedSystemTheme;

  if (rawMode === "dark" || rawMode === "light") return rawMode;
  if (rawMode === "system") return resolvedSystemTheme;
  if (!isValidDate(now)) return resolvedSystemTheme;

  if (rawMode === "scheduled") {
    const lightTime = settings?.themeLightTime ?? DEFAULT_THEME_LIGHT_TIME;
    const darkTime = settings?.themeDarkTime ?? DEFAULT_THEME_DARK_TIME;
    if (!isValidThemeTime(lightTime) || !isValidThemeTime(darkTime)) return resolvedSystemTheme;

    const lightMinutes = minutesFromTime(lightTime);
    const darkMinutes = minutesFromTime(darkTime);
    const currentMinutes = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;

    // 两个切换时刻相同，没有独立深色时段，因此保持浅色。
    if (lightMinutes === darkMinutes) return "light";
    const isLight =
      lightMinutes < darkMinutes
        ? currentMinutes >= lightMinutes && currentMinutes < darkMinutes
        : currentMinutes >= lightMinutes || currentMinutes < darkMinutes;
    return isLight ? "light" : "dark";
  }

  const latitude = settings?.themeLatitude ?? DEFAULT_THEME_LATITUDE;
  const longitude = settings?.themeLongitude ?? DEFAULT_THEME_LONGITUDE;
  if (!isValidThemeLatitude(latitude) || !isValidThemeLongitude(longitude)) {
    return resolvedSystemTheme;
  }

  const sunTimes = calculateSunTimes(now, latitude, longitude);
  if (sunTimes.kind === "polarDay") return "light";
  if (sunTimes.kind === "polarNight") return "dark";
  if (sunTimes.kind === "invalid") return resolvedSystemTheme;

  // 远端地点的事件可能落到本机前天或明天。查找前后多个日历日，
  // 以当前时刻之前最近的一次切换为准。
  const events: Array<{ timestamp: number; theme: ResolvedTheme }> = [];
  let latest: { timestamp: number; theme: ResolvedTheme } | undefined;
  let previousPolarTheme: ResolvedTheme | undefined;
  for (let dayOffset = -3; dayOffset <= 2; dayOffset += 1) {
    const date = new Date(now.getTime());
    date.setDate(date.getDate() + dayOffset);
    const result = dayOffset === 0 ? sunTimes : calculateSunTimes(date, latitude, longitude);
    if (result.kind === "regular") {
      events.push({ timestamp: result.sunrise.getTime(), theme: "light" });
      events.push({ timestamp: result.sunset.getTime(), theme: "dark" });
    } else if (dayOffset === -1 && (result.kind === "polarDay" || result.kind === "polarNight")) {
      // 极态结束后的首个常规日，在首次日出或日落前仍延续昨天的极态。
      previousPolarTheme = result.kind === "polarDay" ? "light" : "dark";
    }
  }

  for (const event of events) {
    if (event.timestamp <= now.getTime() && (!latest || event.timestamp > latest.timestamp)) {
      latest = event;
    }
  }
  return latest?.theme ?? previousPolarTheme ?? resolvedSystemTheme;
}

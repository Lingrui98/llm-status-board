import { describe, expect, it } from "vitest";
import {
  USAGE_CSV_HEADERS,
  UTF8_BOM,
  buildUsageCsv,
  defaultCsvFileName,
  escapeCsvField,
  kindLabelOf,
  localDateKey,
  normalizeDateKey,
} from "./reportCsv";
import type { AccountConfig, BalanceSnapshot, ProviderKind, RefreshOutcome } from "./types";

function account(id: string, name: string, kind: ProviderKind): AccountConfig {
  return {
    id,
    name,
    kind,
    enabled: true,
    baseUrl: "https://example.com",
    apiKey: "",
    token: "",
    userId: null,
    username: "",
    password: "",
    quotaPerUnit: null,
    custom: null,
  };
}

function outcome(acc: string, dailyUsage: NonNullable<RefreshOutcome["info"]>["dailyUsage"]): RefreshOutcome {
  return {
    accountId: acc,
    ok: true,
    info: {
      balance: null,
      used: null,
      total: null,
      requests: null,
      note: null,
      extras: [],
      raw: null,
      fetchedAt: "2026-10-10T08:00:00.000Z",
      dailyUsage,
    },
    error: null,
  };
}

function snap(accountId: string, ts: string, balance: number, currency = "USD"): BalanceSnapshot {
  return { ts, accountId, balance, currency };
}

/** 拆行（去掉 BOM 与末尾空行），便于逐行断言 */
function lines(csv: string): string[] {
  expect(csv.startsWith(UTF8_BOM)).toBe(true);
  return csv.slice(UTF8_BOM.length).split("\r\n").slice(0, -1);
}

const acctA = account("a1", "某中转", "newApi");
const acctB = account("b1", "Kimi 订阅", "moonshot");

describe("reportCsv：转义与日期工具", () => {
  it("RFC 4180：逗号/引号/换行字段加引号并双写内部引号", () => {
    expect(escapeCsvField("普通")).toBe("普通");
    expect(escapeCsvField("含,逗号")).toBe('"含,逗号"');
    expect(escapeCsvField('含"引号"')).toBe('"含""引号"""');
    expect(escapeCsvField("含\n换行")).toBe('"含\n换行"');
    expect(escapeCsvField("")).toBe("");
  });

  it("normalizeDateKey：纯日期不换算、带时区 ISO 取自身日历日、非法返回空串", () => {
    expect(normalizeDateKey("2026-10-05")).toBe("2026-10-05");
    expect(normalizeDateKey("2026-10-05T23:59:59+08:00")).toBe("2026-10-05"); // 有日期前缀优先，不换算
    // 带时区的时间戳按「其自身时区」的日历日归档：与本机时区无关（CI 跑 UTC、Windows 跑 UTC+8 结论一致）
    expect(normalizeDateKey("2026-10-05T08:30:00.000Z")).toBe("2026-10-05");
    expect(normalizeDateKey("2026-10-05T00:30:00+08:00")).toBe("2026-10-05");
    expect(normalizeDateKey("2026-10-05T23:30:00-11:00")).toBe("2026-10-05");
    // 无时区的本地时间字符串：字面日期
    expect(normalizeDateKey("2026-10-05T08:30:00")).toBe("2026-10-05");
    expect(normalizeDateKey("")).toBe("");
    expect(normalizeDateKey(null)).toBe("");
    expect(normalizeDateKey("  ")).toBe("");
    expect(normalizeDateKey("乱码")).toBe("");
  });

  it("localDateKey 与默认文件名", () => {
    const local = new Date(2026, 9, 5, 12, 0, 0);
    expect(localDateKey(local)).toBe("2026-10-05");
    expect(defaultCsvFileName(local)).toBe("llm-usage-2026-10-05.csv");
    expect(defaultCsvFileName("2026-01-09T12:00:00Z")).toMatch(/^llm-usage-\d{4}-\d{2}-\d{2}\.csv$/);
  });

  it("kindLabelOf 取 PROVIDER_KINDS label，未知类型回退原值", () => {
    expect(kindLabelOf("newApi")).toBe("new-api 系中转");
    expect(kindLabelOf("moonshot")).toBe("月之暗面 Kimi/Moonshot");
    expect(kindLabelOf("unknownKind")).toBe("unknownKind");
  });
});

describe("reportCsv：列与行", () => {
  it("表头顺序固定且首字符为 UTF-8 BOM，行尾 CRLF（AC-10）", () => {
    const csv = buildUsageCsv([], [], []);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toBe(UTF8_BOM + USAGE_CSV_HEADERS.join(",") + "\r\n");
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).not.toContain("\n\n");
  });

  it("行集合 = union(dailyUsage 日期, 快照本地日期)，日期升序（AC-10）", () => {
    const acct = account("a1", "A 站", "deepSeek");
    const csv = buildUsageCsv(
      [acct],
      [
        outcome("a1", [
          { date: "2026-10-02", requests: 3, cost: 1.5, costUnit: "USD" },
          { date: "2026-10-04", requests: 4, cost: 2.25, costUnit: "USD" },
        ]),
      ],
      [snap("a1", "2026-10-01T12:00:00.000Z", 50), snap("a1", "2026-10-04T12:00:00.000Z", 40)],
    );
    const rows = lines(csv);
    expect(rows).toHaveLength(4); // 表头 + 3 行（1、2、4 日）
    expect(rows[0]).toBe(USAGE_CSV_HEADERS.join(","));

    const cells = rows.slice(1).map((r) => parseCsvField(r));
    expect(cells.map((c) => c.length)).toEqual([8, 8, 8]); // 列数恒定
    expect(cells.map((c) => c[3])).toEqual(["2026-10-01", "2026-10-02", "2026-10-04"]); // 日期升序
    expect(cells[0][7]).toBe("50"); // 10-01 只有快照
    expect(cells[1].slice(4, 7)).toEqual(["1.5", "3", ""]); // 10-02 有花费/请求、无 token
    expect(cells[2].slice(4, 8)).toEqual(["2.25", "4", "", "40"]);
    expect(cells.every((c) => c[0] === "A 站" && c[1] === "DeepSeek 官方" && c[2] === "USD")).toBe(true);
  });

  it("无 dailyUsage 的账号：花费/请求/Token 为空串（不是 null/undefined/NaN）", () => {
    const acct = account("a1", "只有余额", "custom");
    const csv = buildUsageCsv([acct], [], [snap("a1", "2026-10-03T12:00:00.000Z", 12.5, "CNY")]);
    const rows = lines(csv);
    expect(rows).toHaveLength(2);
    const cells = parseCsvField(rows[1]);
    expect(cells).toEqual(["只有余额", "自定义 HTTP 查询", "CNY", "2026-10-03", "", "", "", "12.5"]);
    expect(csv).not.toContain("undefined");
    expect(csv).not.toContain("null");
    expect(csv).not.toContain("NaN");
  });

  it("账号名含逗号/引号时列不错位（AC-10）", () => {
    const acct = account("a1", 'A, "特殊" 站', "newApi");
    const csv = buildUsageCsv(
      [acct],
      [outcome("a1", [{ date: "2026-10-02", requests: 1, cost: 0.5, costUnit: "USD" }])],
      [snap("a1", "2026-10-02T12:00:00.000Z", 9.5)],
    );
    const rows = lines(csv);
    expect(rows[1]).toBe('"A, ""特殊"" 站",new-api 系中转,USD,2026-10-02,0.5,1,,9.5');
    // 转义后字段数仍为 8（用严格 CSV 解析验证列不错位）
    expect(parseCsvField(rows[1])).toHaveLength(USAGE_CSV_HEADERS.length);
  });

  it("每日 token：优先 tokens，否则 input+output；缺失留空", () => {
    const acct = account("a1", "T", "deepSeek");
    const csv = buildUsageCsv(
      [acct],
      [
        outcome("a1", [
          { date: "2026-10-01", tokens: 1234 },
          { date: "2026-10-02", inputTokens: 100, outputTokens: 23 },
          { date: "2026-10-03" },
        ]),
      ],
      [],
    );
    const rows = lines(csv);
    expect(rows[1].endsWith(",1234,")).toBe(true);
    expect(rows[1]).toContain(",1234,"); // 10-01：tokens 字段
    expect(rows[2]).toContain(",123,"); // 10-02：input+output
    expect(rows[3].endsWith(",,,")).toBe(true); // 10-03：无 token/花费/请求
  });

  it("币种优先 costUnit，否则快照币种；credits 账号不产生任何行（D-1/AC-4）", () => {
    const csv = buildUsageCsv(
      [acctA, acctB],
      [
        outcome("a1", [{ date: "2026-10-02", cost: 1, costUnit: "CNY" }]),
        // Kimi 有每日用量，但币种是点数单位 → 一行都不该出现
        outcome("b1", [{ date: "2026-10-02", tokens: 500 }]),
      ],
      [snap("a1", "2026-10-02T12:00:00.000Z", 7, "CNY"), snap("b1", "2026-10-02T12:00:00.000Z", 90, "CREDITS")],
    );
    const rows = lines(csv);
    expect(rows).toHaveLength(2); // 表头 + 仅 CNY 那行
    expect(rows[1]).toBe("某中转,new-api 系中转,CNY,2026-10-02,1,,,7");
    expect(csv).not.toContain("Kimi 订阅");
    expect(csv).not.toContain("CREDITS");
  });

  it("D-1 边界：同账号既有 credits 又有法币快照 → credits 日不出行、法币日照常", () => {
    const acct = account("a1", "混合账号", "moonshot");
    const csv = buildUsageCsv(
      [acct],
      [],
      [
        // 本地日 10-02 只有 credits 快照；10-04 是法币快照
        snap("a1", "2026-10-02T12:00:00+08:00", 900, "credits"),
        snap("a1", "2026-10-04T12:00:00+08:00", 8.5, "USD"),
      ],
    );
    const cells = lines(csv).slice(1).map((r) => parseCsvField(r));
    expect(cells).toHaveLength(1); // 只有法币那一天
    expect(cells[0][2]).toBe("USD");
    expect(cells[0][3]).toBe("2026-10-04");
    expect(cells[0][7]).toBe("8.5");
    expect(csv).not.toContain("CREDITS");
    expect(csv).not.toContain("credits");
  });

  it("N-1：混合账号「credits 花费日且当日无快照」不导出，法币日照常且币种正确", () => {
    const acct = account("a1", "混合二号", "newApi");
    const csv = buildUsageCsv(
      [acct],
      [
        outcome("a1", [
          // 该日花费 900，单位是 credits，且**没有任何快照** —— 修复前会回落账号级 USD 并导出
          { date: "2026-10-02", cost: 900, costUnit: "CREDITS" },
          { date: "2026-10-03", cost: 1.5, costUnit: "USD" },
        ]),
      ],
      // 只有法币日有快照
      [snap("a1", "2026-10-03T12:00:00+08:00", 42.5, "USD")],
    );
    const rows = lines(csv);
    expect(rows).toHaveLength(2); // 表头 + 仅法币日
    expect(rows[1]).toBe("混合二号,new-api 系中转,USD,2026-10-03,1.5,,,42.5");
    // 关键回归：credits 花费日那行（修复前实得 `混合二号,new-api 系中转,USD,2026-10-02,900,,,`）必须不存在
    expect(csv).not.toContain("2026-10-02");
    expect(csv).not.toContain("900");
    expect(csv).not.toContain("CREDITS");
    expect(csv).not.toContain("credits");
  });

  it("N-1：当日快照是 credits、当日花费单位缺失时同样不出行", () => {
    const acct = account("a1", "快照点数账号", "moonshot");
    const csv = buildUsageCsv(
      [acct],
      [outcome("a1", [{ date: "2026-10-02", cost: 3 }])], // 无 costUnit
      [snap("a1", "2026-10-02T12:00:00+08:00", 800, "credit")], // 单数写法
    );
    const rows = lines(csv);
    expect(rows).toHaveLength(1); // 只有表头
    expect(csv).not.toContain("快照点数账号");
  });

  it("N-1：非币种 costUnit（如 %）继续回落到当日快照币种，不误判为 credits", () => {
    const acct = account("a1", "百分号账号", "zhipu");
    const csv = buildUsageCsv(
      [acct],
      [outcome("a1", [{ date: "2026-10-02", cost: 12, costUnit: "%" }])],
      [snap("a1", "2026-10-02T12:00:00+08:00", 5.5, "CNY")],
    );
    const cells = parseCsvField(lines(csv)[1]);
    expect(cells[2]).toBe("CNY");
    expect(cells[3]).toBe("2026-10-02");
    expect(cells[4]).toBe("12");
    expect(cells[7]).toBe("5.5");
  });

  it("D-1：credits 是唯一币种时不产生行；CREDIT 单数写法同样跳过", () => {
    const single = account("c1", "单数点数账号", "zhipu");
    const csv = buildUsageCsv(
      [single],
      [outcome("c1", [{ date: "2026-10-02", cost: 1, costUnit: "CREDIT" }])],
      [snap("c1", "2026-10-02T12:00:00.000Z", 100, "CREDIT")],
    );
    expect(lines(csv)).toHaveLength(1); // 只有表头
    expect(csv).not.toContain("单数点数账号");
  });

  it("dailyUsage 的 ISO 时间戳取自身日历日（不随本机时区漂移）", () => {
    const acct = account("a1", "A", "deepSeek");
    const csv = buildUsageCsv([acct], [outcome("a1", [{ date: "2026-10-05T08:30:00.000Z", cost: 2 }])], []);
    const cells = parseCsvField(lines(csv)[1]);
    expect(cells[3]).toBe("2026-10-05");
    expect(cells.slice(4)).toEqual(["2", "", "", ""]);
  });

  it("当日余额快照取该日本地时间最晚的一条，不串日", () => {
    const acct = account("a1", "A", "deepSeek");
    // 用带本地偏移的 ISO 时间（+08:00）构造：两个快照落在本地 10-02，第三个落在本地 10-04
    const csv = buildUsageCsv(
      [acct],
      [],
      [
        snap("a1", "2026-10-02T09:00:00+08:00", 100),
        snap("a1", "2026-10-02T21:00:00+08:00", 80),
        snap("a1", "2026-10-04T10:00:00+08:00", 75),
      ],
    );
    const rows = lines(csv);
    expect(rows).toHaveLength(3); // 表头 + 两个本地日（10-02、10-04）
    expect(rows.slice(1).map((r) => parseCsvField(r)[7])).toEqual(["80", "75"]); // 10-02 取 21:00 的 80
  });

  it("accountIds 过滤只导出指定账号；空账号列表只出表头", () => {
    const csv = buildUsageCsv(
      [acctA, acctB],
      [],
      [snap("a1", "2026-10-02T12:00:00.000Z", 5), snap("b1", "2026-10-02T12:00:00.000Z", 6)],
      { accountIds: ["b1"] },
    );
    const rows = lines(csv);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("Kimi 订阅");
    expect(rows[1]).not.toContain("某中转");
  });

  it("日期来自 dailyUsage 的 ISO 时间戳时按自身日历日归档", () => {
    const acct = account("a1", "A", "deepSeek");
    const csv = buildUsageCsv([acct], [outcome("a1", [{ date: "2026-10-05T08:30:00.000Z", cost: 2 }])], []);
    const cells = parseCsvField(lines(csv)[1]);
    expect(cells[3]).toBe("2026-10-05");
    expect(cells.slice(4)).toEqual(["2", "", "", ""]);
  });
});

/** 极简严格 CSV 解析器（仅测试用）：验证转义后列数与内容可正确还原 */
function parseCsvField(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

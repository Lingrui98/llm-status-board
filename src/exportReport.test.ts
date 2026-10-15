import { describe, expect, it, vi } from "vitest";
import { countCsvRows, exportErrorMessage, exportUsageCsv } from "./exportReport";
import { UTF8_BOM } from "./reportCsv";
import type { AccountConfig, BalanceSnapshot, ProviderKind, RefreshOutcome } from "./types";

function account(id: string, name: string, kind: ProviderKind = "newApi"): AccountConfig {
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

function snap(accountId: string, ts: string, balance: number): BalanceSnapshot {
  return { ts, accountId, balance, currency: "USD" };
}

const ACCOUNTS = [account("a1", "某中转")];
const OUTCOMES = [outcome("a1", [{ date: "2026-10-02", cost: 1.5, requests: 3, costUnit: "USD" }])];
const SNAPSHOTS = [snap("a1", "2026-10-02T12:00:00.000Z", 20)];

describe("exportReport：导出编排", () => {
  it("选好路径后写入：内容含 BOM，返回行数与路径", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const result = await exportUsageCsv(ACCOUNTS, OUTCOMES, SNAPSHOTS, {
      pickPath: async () => "C:/Users/x/报表.csv",
      writeFile,
    });
    expect(result).toEqual({ status: "exported", path: "C:/Users/x/报表.csv", rowCount: 1 });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, content] = writeFile.mock.calls[0] as [string, string];
    expect(path).toBe("C:/Users/x/报表.csv");
    expect(content.startsWith(UTF8_BOM)).toBe(true);
    expect(content).toContain("账号名称,账号类型,币种,日期,当日花费,当日请求数,当日Token,当日余额快照");
    expect(content).toContain("某中转,new-api 系中转,USD,2026-10-02,1.5,3,,20");
    expect(content.endsWith("\r\n")).toBe(true);
  });

  it("用户取消（选路径返回 null）：不写盘，返回 cancelled", async () => {
    const writeFile = vi.fn();
    const result = await exportUsageCsv(ACCOUNTS, OUTCOMES, SNAPSHOTS, {
      pickPath: async () => null,
      writeFile,
    });
    expect(result).toEqual({ status: "cancelled" });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("写盘失败（如 Rust 返回 Err 字符串）：返回可读错误，不抛异常", async () => {
    const result = await exportUsageCsv(ACCOUNTS, OUTCOMES, SNAPSHOTS, {
      pickPath: async () => "C:/Users/x/报表.csv",
      writeFile: async () => {
        throw "权限不足：无法写入该路径";
      },
    });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toBe("权限不足：无法写入该路径");
  });

  it("选路径阶段异常同样被兜住", async () => {
    const result = await exportUsageCsv(ACCOUNTS, OUTCOMES, SNAPSHOTS, {
      pickPath: async () => {
        throw new Error("对话框不可用");
      },
      writeFile: vi.fn(),
    });
    expect(result).toEqual({ status: "error", message: "对话框不可用" });
  });

  it("无任何数据行时仍导出表头（不静默失败）", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const result = await exportUsageCsv([], [], [], {
      pickPath: async () => "C:/tmp/empty.csv",
      writeFile,
    });
    expect(result).toEqual({ status: "exported", path: "C:/tmp/empty.csv", rowCount: 0 });
    const content = (writeFile.mock.calls[0] as [string, string])[1];
    expect(countCsvRows(content)).toBe(0);
    expect(content).toBe(UTF8_BOM + "账号名称,账号类型,币种,日期,当日花费,当日请求数,当日Token,当日余额快照\r\n");
  });

  it("accountIds 过滤生效", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    await exportUsageCsv([account("a1", "甲"), account("b1", "乙")], [], [snap("a1", "2026-10-02T12:00:00.000Z", 1), snap("b1", "2026-10-02T12:00:00.000Z", 2)], {
      accountIds: ["b1"],
      pickPath: async () => "C:/tmp/x.csv",
      writeFile,
    });
    const content = (writeFile.mock.calls[0] as [string, string])[1];
    expect(content).toContain("乙");
    expect(content).not.toContain("甲");
  });

  it("默认文件名可注入（用于断言 dialog 参数不含日期依赖）", async () => {
    const pickPath = vi.fn().mockResolvedValue("C:/tmp/x.csv");
    await exportUsageCsv(ACCOUNTS, OUTCOMES, SNAPSHOTS, {
      pickPath,
      writeFile: async () => {},
      defaultName: "固定名.csv",
    });
    expect(pickPath).toHaveBeenCalledWith("固定名.csv");
  });
});

describe("exportReport：错误文案", () => {
  it("字符串 / Error / 其他值都能转成可读文本", () => {
    expect(exportErrorMessage("磁盘已满")).toBe("磁盘已满");
    expect(exportErrorMessage("   ")).toBe("未知错误");
    expect(exportErrorMessage(new Error("IO 错误"))).toBe("IO 错误");
    expect(exportErrorMessage({ code: 1 })).toBe("未知错误");
    expect(exportErrorMessage(null)).toBe("未知错误");
  });

  it("countCsvRows 忽略 BOM 与末尾空行", () => {
    expect(countCsvRows(UTF8_BOM + "h\r\n1\r\n")).toBe(1);
    expect(countCsvRows("h\r\n")).toBe(0);
    expect(countCsvRows("")).toBe(0);
  });
});

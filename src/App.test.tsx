import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import App from "./App";
import type { AppConfig, RefreshOutcome } from "./types";

afterEach(cleanup);

/**
 * jsdom 没有 ResizeObserver，而 recharts 2.x 在渲染时依赖它：
 * 「快照 ≥ 2 条 → 全局统计图表」路径一旦触发就会抛错并卸载整棵 React 树。
 * 这里补一个空实现（只在测试环境生效，不影响应用代码）。
 */
if (!("ResizeObserver" in globalThis)) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", { value: ResizeObserverStub, writable: true });
}

// mock Tauri IPC 层
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
// mock dialog 插件（jsdom 无原生对话框；macOS 上 window.confirm 也不可用）
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(),
  open: vi.fn(),
  confirm: vi.fn(),
}));
import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";

const mockInvoke = vi.mocked(invoke);
const mockSave = vi.mocked(save);
const mockOpen = vi.mocked(open);
const mockConfirm = vi.mocked(confirm);

function makeConfig(accounts: AppConfig["accounts"]): AppConfig {
  return {
    version: 1,
    settings: { autoRefreshSec: 0, refreshOnStart: false, proxy: null },
    accounts,
  };
}

const dsAccount = {
  id: "acc-ds",
  name: "DeepSeek 官方",
  kind: "deepSeek" as const,
  enabled: true,
  baseUrl: "https://api.deepseek.com",
  apiKey: "sk-x",
  token: "",
  refreshToken: "",
  userId: null,
  username: "",
  password: "",
  quotaPerUnit: null,
  custom: null,
};

const relayAccount = {
  id: "acc-relay",
  name: "某某中转",
  kind: "newApi" as const,
  enabled: true,
  baseUrl: "https://relay.example.com",
  apiKey: "",
  token: "tok",
  refreshToken: "",
  userId: 1,
  username: "",
  password: "",
  quotaPerUnit: null,
  custom: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInvoke.mockReset();
});

describe("App 看板", () => {
  it("无账号时显示空状态引导", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeConfig([]));
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("还没有任何账号")).toBeTruthy();
    });
    expect(mockInvoke).toHaveBeenCalledWith("get_config");
  });

  it("刷新后渲染账号卡片与汇总（成功与失败并存）", async () => {
    const cfg = makeConfig([dsAccount, relayAccount]);
    const outcomes: RefreshOutcome[] = [
      {
        accountId: "acc-ds",
        ok: true,
        info: {
          balance: { amount: 110.5, currency: "CNY" },
          used: null,
          total: null,
          requests: 42,
          note: null,
          extras: [{ key: "赠送余额", value: "10.00" }],
          raw: { balance_infos: [] },
          fetchedAt: "2026-10-10T12:00:00+08:00",
          newToken: null,
          newRefreshToken: null,
        },
        error: null,
      },
      {
        accountId: "acc-relay",
        ok: false,
        info: null,
        error: "HTTP 401: 无效的访问令牌",
      },
    ];

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(cfg);
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      if (cmd === "refresh_all") return Promise.resolve(outcomes);
      return Promise.resolve([]);
    });

    render(<App />);
    // 配置加载后出现两个卡片名称
    await waitFor(() => {
      expect(screen.getByText("DeepSeek 官方")).toBeTruthy();
      expect(screen.getByText("某某中转")).toBeTruthy();
    });

    // 点「立即刷新」触发 refresh_all
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("refresh_all");
    });

    // 成功卡片：余额、附加行、请求数
    await waitFor(() => {
      expect(screen.getByText("110.50 CNY")).toBeTruthy();
    });
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("赠送余额")).toBeTruthy();
    // 失败卡片：错误信息展示
    expect(screen.getByText(/无效的访问令牌/)).toBeTruthy();
    // 汇总：2 个监控账号、1 正常 1 异常、CNY 合计
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("¥110.50")).toBeTruthy();
  });
  it("启动时加载上次刷新结果（无需点刷新即可见旧数据）", async () => {
    const lastOutcome: RefreshOutcome = {
      accountId: "acc-ds",
      ok: true,
      info: {
        balance: { amount: 88.88, currency: "CNY" },
        used: null,
        total: null,
        requests: null,
        note: null,
        extras: [],
        raw: null,
        fetchedAt: "2026-10-09T08:30:00+08:00",
        newToken: null,
        newRefreshToken: null,
      },
      error: null,
    };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeConfig([dsAccount]));
      if (cmd === "get_last_results") return Promise.resolve([lastOutcome]);
      return Promise.resolve([]);
    });

    render(<App />);
    // 无需任何交互，上次余额直接出现
    await waitFor(() => {
      expect(screen.getByText("88.88 CNY")).toBeTruthy();
    });
    // 卡片显示「更新于 …」时间戳（断言与时区无关：CI 跑在 UTC，具体时刻随运行环境时区变化）
    expect(screen.getByText(/更新于/)).toBeTruthy();
    // refresh_all 不应被自动调用（refreshOnStart=false）
    expect(mockInvoke).not.toHaveBeenCalledWith("refresh_all");
  });

  it("启动时跳过已删除账号的旧结果", async () => {
    const staleOutcome: RefreshOutcome = {
      accountId: "acc-deleted",
      ok: true,
      info: {
        balance: { amount: 1.23, currency: "USD" },
        used: null,
        total: null,
        requests: null,
        note: null,
        extras: [],
        raw: null,
        fetchedAt: "2026-10-01T00:00:00+08:00",
        newToken: null,
        newRefreshToken: null,
      },
      error: null,
    };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeConfig([dsAccount]));
      if (cmd === "get_last_results") return Promise.resolve([staleOutcome]);
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("DeepSeek 官方")).toBeTruthy();
    });
    // 已删除账号（acc-deleted）的旧数据不应出现
    await waitFor(() => {
      expect(screen.queryByText("1.23 USD")).toBeNull();
    });
  });
});

describe("App 设置页", () => {
  it("切换到设置显示账号表格，并可返回看板", async () => {
    const cfg = makeConfig([relayAccount]);
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(cfg);
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("某某中转")).toBeTruthy();
    });

    // 进入设置
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("账号管理")).toBeTruthy();
    });
    // 表格里能看到账号行与认证方式
    expect(screen.getByText("new-api 系中转")).toBeTruthy();
    expect(screen.getByText("Token")).toBeTruthy();

    // 返回看板
    fireEvent.click(screen.getByRole("button", { name: "返回看板" }));
    await waitFor(() => {
      expect(screen.queryByText("账号管理")).toBeNull();
    });
  });

  it("编辑账号进入表单并显示类型对应的认证字段", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeConfig([relayAccount]));
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("某某中转")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("账号管理")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));

    // 表单出现：newApi 类型应有访问令牌与用户 ID 字段（精确匹配标签 span，避开 hint 文案）
    await waitFor(() => {
      expect(screen.getByText("访问令牌 (access_token)")).toBeTruthy();
    });
    expect(screen.getByText("用户 ID (New-Api-User)")).toBeTruthy();
    // 名称输入框带初始值
    const nameInput = screen.getByDisplayValue("某某中转") as HTMLInputElement;
    expect(nameInput).toBeTruthy();
    // Base URL 带初始值
    expect(screen.getByDisplayValue("https://relay.example.com")).toBeTruthy();
  });
});

describe("App 配置导入/导出", () => {
  const baseAccount = {
    id: "acc-1",
    name: "本机账号",
    kind: "deepSeek" as const,
    enabled: true,
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-1",
    token: "",
    refreshToken: "",
    userId: null,
    username: "",
    password: "",
    quotaPerUnit: null,
    custom: null,
  };

  const importedConfig: AppConfig = {
    version: 1,
    settings: { autoRefreshSec: 600, refreshOnStart: true, proxy: null },
    accounts: [
      baseAccount,
      {
        ...baseAccount,
        id: "acc-2",
        name: "导入的新账号",
        kind: "sub2Api",
        baseUrl: "https://relay.example.com",
      },
    ],
  };

  it("导出：选路径后调用 export_config", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeConfig([baseAccount]));
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      if (cmd === "export_config") return Promise.resolve(undefined);
      return Promise.resolve([]);
    });
    mockSave.mockResolvedValue("C:/Users/x/Desktop/lsb-config.json");

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("本机账号")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("账号管理")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "导出配置" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("export_config", {
        path: "C:/Users/x/Desktop/lsb-config.json",
      });
    });
    // 成功提示包含路径
    await waitFor(() => {
      expect(screen.getByText(/已导出到/)).toBeTruthy();
    });
  });

  it("导入：确认后合并账号并刷新表单", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeConfig([baseAccount]));
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      if (cmd === "import_config") return Promise.resolve(importedConfig);
      return Promise.resolve([]);
    });
    mockConfirm.mockResolvedValue(true);
    mockOpen.mockResolvedValue("C:/Users/x/Desktop/lsb-config.json");

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("本机账号")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("账号管理")).toBeTruthy();
    });

    // 导入前只有 1 个账号
    expect(screen.queryByText("导入的新账号")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "导入配置" }));
    // 合并后的新账号出现在表格里
    await waitFor(() => {
      expect(screen.getByText("导入的新账号")).toBeTruthy();
    });
    expect(mockInvoke).toHaveBeenCalledWith("import_config", {
      path: "C:/Users/x/Desktop/lsb-config.json",
    });
    // 成功提示显示账号数
    expect(screen.getByText("已导入 2 个账号")).toBeTruthy();
  });

  it("导入取消确认后不做任何事", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeConfig([baseAccount]));
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      return Promise.resolve([]);
    });
    mockConfirm.mockResolvedValue(false);

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("本机账号")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("账号管理")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "导入配置" }));

    await waitFor(() => {
      expect(mockConfirm).toHaveBeenCalled();
    });
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalledWith("import_config", expect.anything());
  });
});

/* ---------------- R14：提醒与洞察设置 + 配置化阈值 ---------------- */

/** 造一份带 R14 阈值的配置（未传的字段保持缺省，等价于旧配置） */
function makeR14Config(accounts: AppConfig["accounts"], settings: Partial<AppConfig["settings"]> = {}): AppConfig {
  return {
    version: 1,
    settings: { autoRefreshSec: 0, refreshOnStart: false, proxy: null, ...settings },
    accounts,
  };
}

function balanceOutcome(accountId: string, amount: number, currency: string): RefreshOutcome {
  return {
    accountId,
    ok: true,
    info: {
      balance: { amount, currency },
      used: null,
      total: null,
      requests: null,
      note: null,
      extras: [],
      raw: null,
      fetchedAt: "2026-10-10T12:00:00.000Z",
      newToken: null,
      newRefreshToken: null,
    },
    error: null,
  };
}

describe("R14 设置页：提醒与洞察", () => {
  // 本分组专用账号（不依赖其他 describe 的局部常量）
  const panelAccount = {
    id: "acc-1",
    name: "本机账号",
    kind: "deepSeek" as const,
    enabled: true,
    baseUrl: "https://api.deepseek.com",
    apiKey: "sk-1",
    token: "",
    refreshToken: "",
    userId: null,
    username: "",
    password: "",
    quotaPerUnit: null,
    custom: null,
  };

  async function openSettings() {
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("账号管理")).toBeTruthy();
    });
  }

  // 阈值控件同时暴露滑块（aria-label）与数字输入（label[for]），显式限定取数字输入框
  const numberField = (label: string) =>
    screen.getByLabelText(label, { selector: "input[type=number]" }) as HTMLInputElement;

  it("显示「提醒与洞察」分组与四项阈值控件，默认值来自缺省配置", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([panelAccount]));
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("本机账号")).toBeTruthy();
    });
    await openSettings();

    expect(screen.getByText("提醒与洞察")).toBeTruthy();
    // 四项阈值控件以可访问名（label）存在：USD 余额 / CNY 余额 / 配额百分比 / 洞察窗口
    expect(numberField("低余额提醒阈值（USD 及其他法币）")).toBeTruthy();
    expect(numberField("低余额提醒阈值（CNY）")).toBeTruthy();
    expect(numberField("配额用量提醒线")).toBeTruthy();
    expect(numberField("洞察统计窗口")).toBeTruthy();
    // 缺省值回落到文档默认：1 / 7 / 85 / 14
    expect(numberField("低余额提醒阈值（USD 及其他法币）").value).toBe("1");
    expect(numberField("低余额提醒阈值（CNY）").value).toBe("7");
    expect(numberField("配额用量提醒线").value).toBe("85");
    expect(numberField("洞察统计窗口").value).toBe("14");
  });

  it("已有配置值直接受控显示（缺省字段回落默认，新字段用落盘值）", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(
          makeR14Config([panelAccount], {
            notifyLowBalanceUsd: 12.5,
            notifyLowBalanceCny: 88,
            notifyQuotaPercent: 60,
            insightWindowDays: 30,
            notifyEnabled: true,
          }),
        );
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("本机账号")).toBeTruthy();
    });
    await openSettings();

    expect(numberField("低余额提醒阈值（USD 及其他法币）").value).toBe("12.5");
    expect(numberField("低余额提醒阈值（CNY）").value).toBe("88");
    expect(numberField("配额用量提醒线").value).toBe("60");
    expect(numberField("洞察统计窗口").value).toBe("30");
    const toggle = screen.getByRole("checkbox", { name: "启用余额 / 配额提醒" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("D-4：配置里合法的大额阈值（USD 5000 / CNY 60000）如实显示，不被夹成滑块旧上界", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(
          makeR14Config([panelAccount], { notifyLowBalanceUsd: 5000, notifyLowBalanceCny: 60000 }),
        );
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("本机账号")).toBeTruthy();
    });
    await openSettings();

    const usd = screen.getByLabelText("低余额提醒阈值（USD 及其他法币）", {
      selector: "input[type=number]",
    }) as HTMLInputElement;
    const cny = screen.getByLabelText("低余额提醒阈值（CNY）", {
      selector: "input[type=number]",
    }) as HTMLInputElement;
    // 关键回归：曾经 USD max=100 / CNY max=1000，这两个合法值会被显示成 100 / 1000
    expect(usd.value).toBe("5000");
    expect(usd.value).not.toBe("100");
    expect(cny.value).toBe("60000");
    expect(cny.value).not.toBe("1000");
    // 渲染阶段不得回写配置（否则就是静默改写用户设置）
    expect(mockInvoke).not.toHaveBeenCalledWith("save_config", expect.anything());
  });

  it("设置页「导出用量 CSV」：按需拉取历史与结果后调 export_csv", async () => {
    const t = new Date(Date.now() - 86_400_000).toISOString();
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([panelAccount]));
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      if (cmd === "get_history")
        return Promise.resolve([{ ts: t, accountId: "acc-1", balance: 9.5, currency: "USD" }]);
      if (cmd === "get_last_results") return Promise.resolve([balanceOutcome("acc-1", 9.5, "USD")]);
      if (cmd === "export_csv") return Promise.resolve(undefined);
      return Promise.resolve([]);
    });
    mockSave.mockResolvedValue("C:/tmp/settings-export.csv");

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("本机账号")).toBeTruthy();
    });
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "导出用量 CSV" }));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith(
        "export_csv",
        expect.objectContaining({ path: "C:/tmp/settings-export.csv" }),
      );
    });
    const call = mockInvoke.mock.calls.find((c) => c[0] === "export_csv");
    const content = (call?.[1] as { content: string }).content;
    expect(content.startsWith("\uFEFF")).toBe(true);
    expect(content).toContain("本机账号");
    await waitFor(() => {
      expect(screen.getByText(/已导出 \d+ 行到/)).toBeTruthy();
    });
  });
});

describe("R14 配置化告警阈值", () => {
  it("默认阈值下余额 5 USD 不提醒（5 ≥ 1）", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([dsAccount]));
      if (cmd === "get_last_results") return Promise.resolve([balanceOutcome("acc-ds", 5, "USD")]);
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("5.00 USD")).toBeTruthy();
    });
    // 无未读通知 → 不存在带未读数的通知中心入口
    expect(screen.queryByRole("button", { name: /通知中心（/ })).toBeNull();
  });

  it("配置 notifyLowBalanceUsd=10 → 同一数据立即产生「余额不足」（AC-6）", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([dsAccount], { notifyLowBalanceUsd: 10 }));
      if (cmd === "get_last_results") return Promise.resolve([balanceOutcome("acc-ds", 5, "USD")]);
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("5.00 USD")).toBeTruthy();
    });
    const bell = await screen.findByRole("button", { name: /通知中心（1 条未读）/ });
    fireEvent.click(bell);
    await waitFor(() => {
      expect(screen.getByText("余额不足")).toBeTruthy();
    });
    expect(screen.getByText(/低于提醒阈值 10\.00 USD/)).toBeTruthy();
  });

  it("配置 notifyEnabled=false → 余额提醒消失，刷新失败仍保留（AC-7）", async () => {
    const cfg = makeR14Config([dsAccount, relayAccount], { notifyEnabled: false, notifyLowBalanceUsd: 10 });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(cfg);
      if (cmd === "get_last_results")
        return Promise.resolve([
          balanceOutcome("acc-ds", 5, "USD"),
          { accountId: "acc-relay", ok: false, info: null, error: "HTTP 500: 服务端错误" },
        ]);
      return Promise.resolve([]);
    });

    render(<App />);
    const bell = await screen.findByRole("button", { name: /通知中心（1 条未读）/ });
    fireEvent.click(bell);
    await waitFor(() => {
      expect(screen.getByText("刷新失败")).toBeTruthy();
    });
    expect(screen.queryByText("余额不足")).toBeNull();
  });

  /* ---------------- D-3：关开关不得凭空产生「已恢复」 ---------------- */

  it("D-3：先产生「余额不足」，再关掉总开关 → 提醒消失且不出现「已恢复」", async () => {
    // 阈值 10、余额 5 → 开启时会产生 lowBalance；关掉后只是「不再提醒」，不是「已恢复」
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(makeR14Config([dsAccount], { notifyEnabled: true, notifyLowBalanceUsd: 10 }));
      if (cmd === "get_last_results") return Promise.resolve([balanceOutcome("acc-ds", 5, "USD")]);
      if (cmd === "config_path") return Promise.resolve("C:/fake/config.json");
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("5.00 USD")).toBeTruthy();
    });

    // 第一轮：确实存在「余额不足」问题
    fireEvent.click(await screen.findByRole("button", { name: /通知中心（1 条未读）/ }));
    await waitFor(() => {
      expect(screen.getByText("余额不足")).toBeTruthy();
    });
    fireEvent.keyDown(document, { key: "Escape" });
    // 关掉通知中心（点击遮罩之外的关闭按钮）；若面板仍在，下面 find 的按钮会命中错误元素
    const closeBtn = screen.queryByRole("button", { name: /关闭/ });
    if (closeBtn) fireEvent.click(closeBtn);

    // 进设置 → 关掉提醒总开关（会写入配置并触发重算）
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => {
      expect(screen.getByText("提醒与洞察")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "启用余额 / 配额提醒" }));
    await waitFor(() => {
      expect((screen.getByRole("checkbox", { name: "启用余额 / 配额提醒" }) as HTMLInputElement).checked).toBe(false);
    });

    // 关开关后打开通知中心：只允许出现 refreshError，lowBalance 的「已恢复」必须为 0。
    // （直接读面板 DOM，避免依赖「未读徽标」这类会随开关变化的中间态）
    const openBell = screen.queryByRole("button", { name: /通知中心（/ });
    if (openBell) fireEvent.click(openBell);
    await waitFor(() => {
      expect(screen.queryByText(/已恢复/)).toBeNull();
    });
    // 回看板后同样不应出现「已恢复」（用「监控账号」确认已回到看板）
    fireEvent.click(screen.getByRole("button", { name: "返回看板" }));
    await waitFor(() => {
      expect(screen.getByText("监控账号")).toBeTruthy();
    });
    expect(screen.queryByText(/已恢复/)).toBeNull();
  });
});

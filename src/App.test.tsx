import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import App from "./App";
import { toLocalDateKey } from "./usageHistory";
import { notificationManualPath } from "./pluginRuntime";
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
// R16：自启插件（走真实 pluginRuntime → 动态 import 本 mock）
vi.mock("@tauri-apps/plugin-autostart", () => ({
  isEnabled: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
}));
// R16：系统通知插件（granted 默认 true；sendNotification 由用例按需替换）
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}));
// R16/R21：事件后端 —— 捕获 App 注册的托盘事件回调（listen）并断言 App 发出的事件（emit）
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
  emit: vi.fn(),
}));
import { invoke } from "@tauri-apps/api/core";
import { confirm, open, save } from "@tauri-apps/plugin-dialog";
import { emit, listen } from "@tauri-apps/api/event";
import { isEnabled as autostartIsEnabled, enable as autostartEnable, disable as autostartDisable } from "@tauri-apps/plugin-autostart";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

const mockInvoke = vi.mocked(invoke);
const mockEmit = vi.mocked(emit);
/** App 发出的 frontend-refresh-settled 次数（R21：刷新结束回报，供托盘恢复菜单） */
const settledCount = () => mockEmit.mock.calls.filter((c) => c[0] === "frontend-refresh-settled").length;
const mockSave = vi.mocked(save);
const mockOpen = vi.mocked(open);
const mockConfirm = vi.mocked(confirm);

/* R16 插件与事件后端的可观测桩 */
const autostartEnabledMock = vi.mocked(autostartIsEnabled);
const autostartEnableMock = vi.mocked(autostartEnable);
const autostartDisableMock = vi.mocked(autostartDisable);
const grantedMock = vi.mocked(isPermissionGranted);
const requestPermMock = vi.mocked(requestPermission);
const notifySend = vi.mocked(sendNotification);
/** 托盘事件回调捕获（App 通过 listen 注册；用例手动触发） */
let traySettingsHandler: (() => void) | null = null;
type EventCb = (e: { payload: unknown }) => void;
const eventHandlers = new Map<string, EventCb>();

vi.mocked(listen).mockImplementation((async (event: string, cb: EventCb) => {
  eventHandlers.set(event, cb);
  if (event === "tray-open-settings") {
    traySettingsHandler = () => cb({ payload: undefined });
  }
  return () => {
    eventHandlers.delete(event);
  };
}) as unknown as typeof listen);

beforeEach(() => {
  eventHandlers.clear();
  traySettingsHandler = null;
  traySettingsHandler = null;
  vi.clearAllMocks();
  mockInvoke.mockReset();
  // 插件桩的默认返回值（必须放在 clearAllMocks 之后，否则会被清掉）
  grantedMock.mockResolvedValue(true);
  requestPermMock.mockResolvedValue("granted");
  autostartEnabledMock.mockResolvedValue(false);
  autostartEnableMock.mockResolvedValue(undefined);
  autostartDisableMock.mockResolvedValue(undefined);
});

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

function balanceOutcome(accountId: string, amount: number, currency: string): RefreshOutcome {  return {
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

/** 失败的刷新结果（用于 §5 整轮失败 / 部分失败场景） */
function failedOutcome(accountId: string): RefreshOutcome {
  return { accountId, ok: false, info: null, error: "HTTP 500" };
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

/* ---------------- R15：本地用量历史接线 ---------------- */

describe("R15 用量历史接线", () => {
  const usageRecord = (date: string, cost: number): Record<string, unknown> => ({
    accountId: "acc-ds",
    date,
    cost,
    currency: "USD",
    requests: 10,
    inputTokens: null,
    outputTokens: null,
    tokens: null,
    usedTotal: null,
    source: "local",
    updatedAt: "2026-06-15T10:00:00.000Z",
  });

  it("启动时拉取 get_usage_history；有记录时分析区展示周对比（含「周期对比」标题）", async () => {
    const today = new Date();
    const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
    const key = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const recent = key(today);

    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([dsAccount]));
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [usageRecord(recent, 12.5)] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith("get_usage_history");
    });
    // 分析区存在（R17：默认收起，先展开再断言小节）
    const analysisHead = await screen.findByRole("button", { name: /用量花费分析/ });
    if (analysisHead.getAttribute("aria-expanded") !== "true") fireEvent.click(analysisHead);
    expect(screen.getByText(/周期对比/)).toBeTruthy();
    // R17 AC-1 行序：洞察 / 分析都在账号卡片网格之后，且洞察在分析之前
    const grid = document.querySelector(".card-grid");
    const insights = document.querySelector(".insights-panel");
    const analysis = document.querySelector(".analysis-panel");
    expect(grid && insights && analysis).toBeTruthy();
    expect(grid!.compareDocumentPosition(insights!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(insights!.compareDocumentPosition(analysis!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // 不应显示「暂无本地用量历史」占位
    expect(screen.queryByText(/暂无本地用量历史/)).toBeNull();
  });

  it("无历史记录（空封套）→ 显示「暂无本地用量历史」占位，看板照常可用", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([dsAccount]));
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    // R17：分析区默认收起，先展开再断言占位
    const analysisHead = await screen.findByRole("button", { name: /用量花费分析/ });
    if (analysisHead.getAttribute("aria-expanded") !== "true") fireEvent.click(analysisHead);
    await waitFor(() => {
      expect(screen.getByText(/暂无本地用量历史/)).toBeTruthy();
    });
    expect(screen.getByText("DeepSeek 官方")).toBeTruthy();
  });

  it("get_usage_history 失败 → 可读提示且看板不崩（AC-1/非阻塞）", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([dsAccount]));
      if (cmd === "get_usage_history") return Promise.reject("用量历史文件格式错误: EOF");
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/本地用量历史读取失败/)).toBeTruthy();
    });
    expect(screen.getByText(/用量历史文件格式错误/)).toBeTruthy();
    // 看板核心内容仍在
    expect(screen.getByText("DeepSeek 官方")).toBeTruthy();
    expect(screen.getByText("监控账号")).toBeTruthy();
  });

  it("upsert_usage_history 失败 → 刷新结果照常展示，只给轻量提示（不把整页判为失败）", async () => {
    const outcomes: RefreshOutcome[] = [
      {
        accountId: "acc-ds",
        ok: true,
        info: {
          balance: { amount: 88.5, currency: "USD" },
          used: null,
          total: null,
          requests: 7,
          dailyUsage: [{ date: "2026-06-15", cost: 11.5, costUnit: "USD" }],
          note: null,
          extras: [],
          raw: null,
          fetchedAt: "2026-06-15T10:00:00.000Z",
          newToken: null,
          newRefreshToken: null,
        },
        error: null,
      },
    ];
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([dsAccount]));
      if (cmd === "refresh_all") return Promise.resolve(outcomes);
      if (cmd === "get_history")
        return Promise.resolve([
          { ts: "2026-06-15T09:00:00+08:00", accountId: "acc-ds", balance: 100, currency: "USD" },
          { ts: "2026-06-15T21:00:00+08:00", accountId: "acc-ds", balance: 88.5, currency: "USD" },
        ]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      if (cmd === "upsert_usage_history") return Promise.reject("磁盘写入失败: 权限不足");
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("DeepSeek 官方")).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));

    // 硬要求：刷新主流程不受历史写入失败影响 —— 新余额照常上屏
    await waitFor(() => {
      expect(screen.getByText("88.50 USD")).toBeTruthy();
    });
    // 重量级失败态没有出现（不把整页判为加载失败）
    expect(screen.queryByText("配置加载失败")).toBeNull();
    // 且「刷新失败」类通知不应因为历史写入失败而产生
    expect(screen.queryByText("刷新失败")).toBeNull();
    // 只有一条可读的轻量提示
    await waitFor(() => {
      expect(screen.getByText(/本地用量历史写入失败/)).toBeTruthy();
    });
    expect(screen.getByText(/磁盘写入失败/)).toBeTruthy();
  });

  it("后端历史写失败仍展示查询结果，但本轮不能继续写used批次", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([dsAccount]));
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      if (cmd === "refresh_all") return Promise.resolve<RefreshOutcome[]>([{
        accountId: "acc-ds", ok: true, historyError: "账本写入失败",
        info: { balance: null, used: { amount: 101, currency: "USD" }, extras: [], fetchedAt: "2026-10-23T12:00:00Z" },
      }]);
      return Promise.resolve([]);
    });
    render(<App />);
    await screen.findByText("DeepSeek 官方");
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await screen.findByText(/本地历史保存失败/);
    expect(screen.getByText(/账本写入失败/)).toBeTruthy();
    expect(screen.queryByText("配置加载失败")).toBeNull();
    expect(mockInvoke.mock.calls.some(([cmd]) => cmd === "upsert_usage_history")).toBe(false);
  });

  it("D-2：B2 行日期用本地日历日（App 透传 todayKey，不落 UTC 日）", async () => {
    // 时间冻结在一个「UTC 日 ≠ 本地日」的瞬间附近仍有意义的时刻：
    // 断言用同源的 toLocalDateKey 计算期望值，因此不管 CI 跑在 UTC 还是 UTC+8 都成立。
    const frozen = new Date("2026-10-15T20:30:00.000Z");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(frozen);
    const expectedDay = toLocalDateKey(frozen);

    const kimi = { ...dsAccount, id: "acc-kimi", name: "Kimi 订阅", kind: "moonshot" as const };
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([kimi]));
      if (cmd === "refresh_all")
        return Promise.resolve<RefreshOutcome[]>([
          {
            accountId: "acc-kimi",
            ok: true,
            info: {
              balance: null, // 无余额 → 走 B2 used 计数器路径
              used: { amount: 1000, currency: "CREDITS" },
              total: null,
              requests: null,
              note: null,
              extras: [],
              raw: null,
              fetchedAt: frozen.toISOString(),
              newToken: null,
              newRefreshToken: null,
            },
            error: null,
          },
        ]);
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      if (cmd === "upsert_usage_history") return Promise.resolve(1);
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => {
      expect(screen.getByText("Kimi 订阅")).toBeTruthy();
    });
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));

    await waitFor(() => {
      const cmds = mockInvoke.mock.calls.map((c) => c[0]);
      expect(cmds.filter((c) => c === "upsert_usage_history").length).toBe(1);
    });
    const call = mockInvoke.mock.calls.find((c) => c[0] === "upsert_usage_history");
    const records = (call?.[1] as { records: { date: string; usedTotal: number | null }[] }).records;
    expect(records).toHaveLength(1);
    // 关键：日期是本地日历日，而不是 toISOString() 的 UTC 日
    expect(records[0].date).toBe(expectedDay);
    expect(records[0].usedTotal).toBe(1000);
    vi.useRealTimers();
  });
});

/* ---------------- R16：常驻与自动化 ---------------- */

/** 每轮 refresh_all 返回可控结果的桩 */
function mockRefreshRounds(
  rounds: RefreshOutcome[][],
  extra: (cmd: string, args: unknown) => unknown = () => undefined,
) {
  let i = 0;
  mockInvoke.mockImplementation((cmd: string, args?: unknown) => {
    const custom = extra(cmd, args);
    if (custom !== undefined) return Promise.resolve(custom);
    if (cmd === "get_config") return Promise.resolve(makeR14Config([r16Account], { systemNotifications: true }));
    if (cmd === "refresh_all") {
      const r = rounds[Math.min(i, rounds.length - 1)];
      i += 1;
      return Promise.resolve(r);
    }
    if (cmd === "get_history") return Promise.resolve([]);
    if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
    return Promise.resolve([]);
  });
}

const r16Account = {
  ...dsAccount,
  id: "acc-r16",
  name: "R16 账号",
};

/** 低余额结果（USD 阈值默认 1）→ 必然产生 lowBalance 问题 */
function lowBalanceRound(): RefreshOutcome[] {
  return [balanceOutcome("acc-r16", 0.5, "USD")];
}

describe("R16 系统通知接线（§4）", () => {
  beforeEach(() => {
    notifySend.mockClear();
    window.localStorage.clear();
  });

  it("开启开关 + 新问题 → 发送一次系统通知（标题=类别名，正文含账号与数值）", async () => {
    mockRefreshRounds([lowBalanceRound()]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));

    await waitFor(() => expect(notifySend).toHaveBeenCalledTimes(1));
    const payload = notifySend.mock.calls[0][0] as { title: string; body: string };
    expect(payload.title).toBe("余额不足");
    expect(payload.body).toContain("R16 账号");
    expect(payload.body).toContain("USD");
  });

  it("AC-10：同一问题在 24h 抑制窗口内再刷新 → 不再发送", async () => {
    mockRefreshRounds([lowBalanceRound(), lowBalanceRound()]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(notifySend).toHaveBeenCalledTimes(1));

    // 第二次刷新（问题仍存在）→ 抑制表命中，不重复弹
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => {
      expect(mockInvoke.mock.calls.filter((c) => c[0] === "refresh_all").length).toBe(2);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(notifySend).toHaveBeenCalledTimes(1);
  });

  it("开关关闭 → 完全不调用发送，也不请求权限", async () => {
    let i = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(makeR14Config([r16Account], { systemNotifications: false }));
      if (cmd === "refresh_all") {
        i += 1;
        return Promise.resolve(lowBalanceRound());
      }
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });
    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(i).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(notifySend).not.toHaveBeenCalled();
    expect(requestPermMock).not.toHaveBeenCalled();
  });

  it("权限被拒 → 不发送、不反复请求（应用内仍可看到通知中心）", async () => {
    grantedMock.mockResolvedValue(false);
    requestPermMock.mockResolvedValue("denied");
    mockRefreshRounds([lowBalanceRound()]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));

    await waitFor(() => expect(requestPermMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(notifySend).not.toHaveBeenCalled();
    // 刷新主流程不受影响（账号名出现在卡片与通知里，故用 getAllByText）
    expect(screen.getAllByText("R16 账号").length).toBeGreaterThan(0);
  });

  it("发送抛错 → 静默降级，刷新结果照常展示（不影响主流程）", async () => {
    notifySend.mockImplementation(() => {
      throw new Error("no notification daemon");
    });
    mockRefreshRounds([lowBalanceRound()]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(notifySend).toHaveBeenCalled());
    // 看板仍然可用，没有整页失败
    expect(screen.queryByText("配置加载失败")).toBeNull();
    expect(screen.getAllByText("R16 账号").length).toBeGreaterThan(0);
  });
});

describe("R16 自动重试接线（§5）", () => {
  beforeEach(() => {
    notifySend.mockClear();
    window.localStorage.clear();
  });

  it("整轮失败 → 按退避重试；第二次成功则停止（不产生并发请求）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let rounds = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(makeR14Config([r16Account], { refreshRetryEnabled: true, refreshRetryMax: 2 }));
      if (cmd === "refresh_all") {
        rounds += 1;
        // 第 1 轮整轮失败（okCount=0）；第 2 轮（重试）成功
        return Promise.resolve(rounds === 1 ? [failedOutcome("acc-r16")] : [balanceOutcome("acc-r16", 9, "USD")]);
      }
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));

    // 第 1 轮全部失败 → 安排重试（倒计时提示出现）
    await waitFor(() => expect(screen.getByText(/刷新失败，\d+s 后重试（第 1\/2 次）/)).toBeTruthy());
    expect(rounds).toBe(1);

    // 推进 1s → 触发第 1 次重试（成功 → 停止，不再有第 2 次）
    await vi.advanceTimersByTimeAsync(1100);
    await waitFor(() => expect(rounds).toBe(2));
    await vi.advanceTimersByTimeAsync(5000);
    expect(rounds).toBe(2); // 成功即停止，没有第 3 轮
    expect(screen.queryByText(/后重试/)).toBeNull();
    vi.useRealTimers();
  });

  it("AC-17：等待重试期间用户手动刷新 → 不产生并发双请求，且旧重试不再叠加", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let rounds = 0;
    let inFlight = 0;
    let maxConcurrent = 0;
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "get_config")
        return makeR14Config([r16Account], { refreshRetryEnabled: true, refreshRetryMax: 2 });
      if (cmd === "refresh_all") {
        rounds += 1;
        inFlight += 1;
        maxConcurrent = Math.max(maxConcurrent, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return [failedOutcome("acc-r16")];
      }
      if (cmd === "get_history") return [];
      if (cmd === "get_usage_history") return { version: 1, records: [] };
      return [];
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(rounds).toBe(1));
    // 第 1 次失败已安排重试（等待中）
    await waitFor(() => expect(screen.getByText(/后重试（第 1\/2 次）/)).toBeTruthy());

    // 用户在等待期间手动刷新 → 立即发起，不与后台重试并发
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(rounds).toBe(2));
    expect(maxConcurrent).toBe(1); // 绝不并发两个请求

    // 推进到原重试到点：不应再叠加出第三轮
    await vi.advanceTimersByTimeAsync(2000);
    await waitFor(() => expect(rounds).toBeGreaterThanOrEqual(2));
    expect(maxConcurrent).toBe(1);
    vi.useRealTimers();
  });

  it("AC-16：达到上限仍失败 → 如实停止（不再安排），UI 不显示「在重试中」", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let rounds = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(makeR14Config([r16Account], { refreshRetryEnabled: true, refreshRetryMax: 1 }));
      if (cmd === "refresh_all") {
        rounds += 1;
        // R16 §5 触发条件：整轮失败 = 启用账号数 > 0 且 okCount === 0
        return Promise.resolve([failedOutcome("acc-r16")]);
      }
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(rounds).toBe(1));

    // 上限 1 → 推进很久也只重试 1 次
    await vi.advanceTimersByTimeAsync(30000);
    await waitFor(() => expect(rounds).toBe(2));
    await vi.advanceTimersByTimeAsync(60000);
    expect(rounds).toBe(2);
    vi.useRealTimers();
  });

  it("AC-15：部分失败（okCount > 0）不触发重试", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let rounds = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(
          makeR14Config([r16Account, { ...dsAccount, id: "acc-2", name: "二号" }], {
            refreshRetryEnabled: true,
            refreshRetryMax: 2,
          }),
        );
      if (cmd === "refresh_all") {
        rounds += 1;
        return Promise.resolve([balanceOutcome("acc-r16", 5, "USD"), failedOutcome("acc-2")]);
      }
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(rounds).toBe(1));
    await vi.advanceTimersByTimeAsync(30000);
    expect(rounds).toBe(1); // 部分失败不重试
    vi.useRealTimers();
  });

  it("重试开关关闭 → 整轮失败也不安排重试", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let rounds = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(makeR14Config([r16Account], { refreshRetryEnabled: false, refreshRetryMax: 3 }));
      if (cmd === "refresh_all") {
        rounds += 1;
        return Promise.resolve([failedOutcome("acc-r16")]);
      }
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(rounds).toBe(1));
    await vi.advanceTimersByTimeAsync(30000);
    expect(rounds).toBe(1);
    vi.useRealTimers();
  });
});

describe("R16 常驻与自动化：设置页与托盘（§1/§2/§6）", () => {
  beforeEach(() => {
    window.localStorage.clear();
    autostartEnabledMock.mockResolvedValue(false);
    autostartEnableMock.mockResolvedValue(undefined);
    autostartDisableMock.mockResolvedValue(undefined);
  });

  it("设置页显示「常驻与通知」分组与全部新设置项", async () => {
    mockRefreshRounds([]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => expect(screen.getByText("常驻与通知")).toBeTruthy());
    expect(screen.getByText("开机自启")).toBeTruthy();
    expect(screen.getByText("系统通知")).toBeTruthy();
    expect(screen.getByText("刷新失败时自动重试")).toBeTruthy();
    expect(screen.getByText("关闭窗口时最小化到系统托盘")).toBeTruthy();
  });

  it("AC-7：自启 enable 失败 → 开关回置为真实值且给可读错误（不谎报已开启）", async () => {
    autostartEnabledMock.mockResolvedValue(false); // 真实状态：关
    autostartEnableMock.mockRejectedValue(new Error("autostart is not supported on this platform"));
    mockRefreshRounds([]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    await waitFor(() => expect(screen.getByText("已关闭")).toBeTruthy());
    const toggle = screen.getByLabelText("开机自启") as HTMLInputElement;
    fireEvent.click(toggle);

    await waitFor(() => expect(screen.getByText(/当前系统不支持开机自启/)).toBeTruthy());
    // 关键：不显示"已开启"
    expect(screen.queryByText("已开启")).toBeNull();
  });

  it("AC-7：自启切换成功 → 徽标显示真实状态「已开启」", async () => {
    let enabled = false;
    autostartEnabledMock.mockImplementation(async () => enabled);
    autostartEnableMock.mockImplementation(async () => {
      enabled = true;
    });
    mockRefreshRounds([]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    await waitFor(() => expect(screen.getByText("已关闭")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("开机自启"));
    await waitFor(() => expect(screen.getByText("已开启")).toBeTruthy());
  });

  it("R21：暂停能力已移除 —— 间隔>0 时定时器始终触发，且没有任何 pause 类 IPC", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let rounds = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(makeR14Config([r16Account], { autoRefreshSec: 1, systemNotifications: false }));
      if (cmd === "refresh_all") {
        rounds += 1;
        return Promise.resolve([balanceOutcome("acc-r16", 5, "USD")]);
      }
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());

    // 定时器不受任何暂停态短路：3 个间隔至少触发 1 轮（自动刷新照常）
    const before = rounds;
    await vi.advanceTimersByTimeAsync(3500);
    expect(rounds).toBeGreaterThan(before);

    // 不再有 pause 类 IPC（命令名里不应出现 pause）
    const calledCommands = mockInvoke.mock.calls.map((c) => String(c[0]));
    expect(calledCommands.some((c) => c.includes("pause"))).toBe(false);

    // 设置页：整页不再出现该能力相关字样与恢复入口；间隔说明写清 0 = 关闭
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => expect(screen.getByText("常驻与通知")).toBeTruthy());
    expect(document.body.textContent).not.toContain("暂停");
    expect(document.body.textContent).not.toContain("恢复自动刷新");
    expect(screen.getByText(/设为 0 即关闭自动刷新/)).toBeTruthy();
    vi.useRealTimers();
  });

  /* ---- R21 task-53：刷新结束回报 + 托盘刷新走同一路径 ---- */

  it("R21①：手动刷新成功 → refresh_all 恰 1 次且恰好回报 1 次 frontend-refresh-settled", async () => {
    let rounds = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([r16Account], { autoRefreshSec: 0 }));
      if (cmd === "refresh_all") {
        rounds += 1;
        return Promise.resolve([balanceOutcome("acc-r16", 5, "USD")]);
      }
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    const baseSettled = settledCount();

    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(rounds).toBe(1));
    await waitFor(() => expect(settledCount()).toBe(baseSettled + 1));
    expect(settledCount()).toBe(baseSettled + 1); // 不多不少
    expect(rounds).toBe(1);
  });

  it("R21②：刷新失败路径 → 同样恰好回报 1 次（不是只在成功路径发）", async () => {
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([r16Account], { autoRefreshSec: 0 }));
      if (cmd === "refresh_all") return Promise.reject("上游中转站超时");
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    const baseSettled = settledCount();

    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(settledCount()).toBe(baseSettled + 1));
    expect(settledCount()).toBe(baseSettled + 1);
  });

  it("R21③：tray-refresh 事件 → 同一 refresh 路径：refresh_all 恰 1 次 + 回报 1 次 + 结果上屏", async () => {
    let rounds = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([r16Account], { autoRefreshSec: 0 }));
      if (cmd === "refresh_all") {
        rounds += 1;
        return Promise.resolve([balanceOutcome("acc-r16", 5, "USD")]);
      }
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    await waitFor(() => expect(eventHandlers.get("tray-refresh")).toBeTruthy());
    const baseSettled = settledCount();

    eventHandlers.get("tray-refresh")?.({ payload: undefined });

    await waitFor(() => expect(rounds).toBe(1)); // 防双跑：一次托盘触发只跑一轮
    await waitFor(() => expect(settledCount()).toBe(baseSettled + 1));
    expect(rounds).toBe(1);
    // 与主面板同一个 refresh：看板金额随之上屏
    await waitFor(() => expect(screen.getByText("$5.00")).toBeTruthy());
  });

  it("R21④：tray-refresh 监听不是死代码 —— 与顶栏按钮调用同一个 refresh", async () => {
    let rounds = 0;
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([r16Account], { autoRefreshSec: 0 }));
      if (cmd === "refresh_all") {
        rounds += 1;
        return Promise.resolve([balanceOutcome("acc-r16", 5, "USD")]);
      }
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    // 监听已注册（存在 → 不是死代码）
    await waitFor(() => expect(eventHandlers.has("tray-refresh")).toBe(true));

    // 顶栏按钮：1 次 refresh_all + 1 次回报
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(rounds).toBe(1));
    const afterButton = settledCount();

    // 托盘事件：同一增量（同一条 refresh 链路，没有第二套逻辑）
    eventHandlers.get("tray-refresh")?.({ payload: undefined });
    await waitFor(() => expect(rounds).toBe(2));
    await waitFor(() => expect(settledCount()).toBe(afterButton + 1));
    expect(rounds).toBe(2);
  });

  it("R21⑤：在途刷新期间再点托盘 → 不发第二个 settled，但在途轮次结束时一定补发一次", async () => {
    // 前提不变量（dev-backend 的托盘恢复逻辑依赖它）：
    //   被 refreshingRef 挡掉的点击不产生新轮次，但它对应的「在途轮次」结束时会走 finally 补发 settled。
    let rounds = 0;
    const releases: ((v: RefreshOutcome[]) => void)[] = [];
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config") return Promise.resolve(makeR14Config([r16Account], { autoRefreshSec: 0 }));
      if (cmd === "refresh_all") {
        rounds += 1;
        // 挂起的在途刷新：由用例决定何时结束
        return new Promise<RefreshOutcome[]>((resolve) => {
          releases.push(resolve);
        });
      }
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    await waitFor(() => expect(eventHandlers.has("tray-refresh")).toBe(true));
    const baseSettled = settledCount();

    // 第一轮开始（挂起中）；顶栏按钮此时 disabled，托盘事件仍可点（真实场景）
    fireEvent.click(screen.getByRole("button", { name: "立即刷新" }));
    await waitFor(() => expect(rounds).toBe(1));
    expect(releases.length).toBe(1);

    // 在途期间再点托盘 → 被 refreshingRef 挡掉：不新增轮次、不提前发 settled
    eventHandlers.get("tray-refresh")?.({ payload: undefined });
    expect(rounds).toBe(1);
    expect(releases.length).toBe(1);
    expect(settledCount()).toBe(baseSettled);

    // 在途轮次结束 → 恰好补发一次 settled（菜单据此恢复，不会永久置灰）
    releases[0]([balanceOutcome("acc-r16", 5, "USD")]);
    await waitFor(() => expect(settledCount()).toBe(baseSettled + 1));
    expect(rounds).toBe(1);
    await waitFor(() => expect(screen.getByText("$5.00")).toBeTruthy());
  });

  it("§6：托盘「打开设置」事件 → 切到设置视图", async () => {
    mockRefreshRounds([]);
    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    await waitFor(() => expect(traySettingsHandler).not.toBeNull());
    traySettingsHandler?.();
    await waitFor(() => expect(screen.getByText("常驻与通知")).toBeTruthy());
  });

  /* ---- task-27：权限被拒提示的文案诚实性 ---- */

  it("task-27：权限被拒 → 提示含手动放行路径，按钮不再是「去授权」而是「重新请求授权」", async () => {
    grantedMock.mockResolvedValue(false);
    requestPermMock.mockResolvedValue("denied");
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(makeR14Config([r16Account], { systemNotifications: true }));
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "设置" }));

    // 提示常驻：标题 + 手动放行路径 + 诚实的按钮文案
    await waitFor(() => expect(screen.getByText("系统通知已被系统拒绝")).toBeTruthy());
    // 平台文案按运行环境推导（jsdom 无平台标识 → 通用文案），断言不依赖具体平台。
    // 提示正文 = 「系统拒绝了通知权限…」+ 手动放行路径，故按提示正文元素做包含匹配。
    const path = notificationManualPath();
    expect(path).toContain("通知");
    const noticeText = document.querySelector(".inline-notice-text");
    expect(noticeText?.textContent ?? "").toContain(path);
    expect(screen.queryByRole("button", { name: "去授权" })).toBeNull();
    expect(screen.getByRole("button", { name: "重新请求授权" })).toBeTruthy();
  });

  it("task-27：权限恢复为已授权 → 被拒提示消失（不是常驻错误）", async () => {
    // 初始查询被拒 → 显示提示；点「重新请求授权」后授权通过 → 提示消失
    let granted = false;
    grantedMock.mockImplementation(async () => granted);
    requestPermMock.mockImplementation(async () => {
      granted = true;
      return "granted";
    });
    mockInvoke.mockImplementation((cmd: string) => {
      if (cmd === "get_config")
        return Promise.resolve(makeR14Config([r16Account], { systemNotifications: true }));
      if (cmd === "get_history") return Promise.resolve([]);
      if (cmd === "get_usage_history") return Promise.resolve({ version: 1, records: [] });
      return Promise.resolve([]);
    });

    render(<App />);
    await waitFor(() => expect(screen.getByText("R16 账号")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "设置" }));
    await waitFor(() => expect(screen.getByText("系统通知已被系统拒绝")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "重新请求授权" }));
    await waitFor(() => expect(screen.queryByText("系统通知已被系统拒绝")).toBeNull());
    expect(screen.getByText("已授权")).toBeTruthy();
  });
});

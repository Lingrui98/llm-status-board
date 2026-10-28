import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ModelServerLogin from "./ModelServerLogin";
import * as api from "../api";

vi.mock("../api", () => ({
  startModelServerLogin: vi.fn(), openModelServerLogin: vi.fn(),
  modelserverLoginStatus: vi.fn(), cancelModelServerLogin: vi.fn(),
}));
const flow = { attemptId: "fixture-modelserver-attempt", authUrl: "https://code.cs.ac.cn/" };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
};
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.startModelServerLogin).mockResolvedValue(flow);
  vi.mocked(api.openModelServerLogin).mockResolvedValue(undefined);
  vi.mocked(api.cancelModelServerLogin).mockResolvedValue(undefined);
});
function setup(hasCredential = false) {
  const onConnected = vi.fn(), onBusyChange = vi.fn();
  const rendered = render(<ModelServerLogin baseUrl="https://codeapi.cs.ac.cn"
    hasCredential={hasCredential} onConnected={onConnected} onBusyChange={onBusyChange} />);
  return { ...rendered, onConnected, onBusyChange };
}

describe("ModelServer embedded browser login", () => {
  it("starts from the API base URL and returns only the refresh token to the form", async () => {
    vi.mocked(api.modelserverLoginStatus).mockResolvedValue({ status: "complete", refreshToken: "fixture-refresh" });
    const { onConnected } = setup();
    fireEvent.click(screen.getByRole("button", { name: "使用网页登录" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith("fixture-refresh"));
    expect(api.startModelServerLogin).toHaveBeenCalledWith("https://codeapi.cs.ac.cn");
    expect(api.openModelServerLogin).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("ModelServer 面板地址")).toBeNull();
  });

  it("reopens the native login window without offering an external-browser fallback", async () => {
    vi.mocked(api.modelserverLoginStatus).mockReturnValue(new Promise(() => {}));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "使用网页登录" }));
    expect(await screen.findByLabelText("ModelServer 面板地址")).toHaveProperty("value", flow.authUrl);
    expect(screen.getByText(/外部浏览器无法回填凭据/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "打开登录窗口" }));
    await waitFor(() => expect(api.openModelServerLogin).toHaveBeenCalledWith(flow.attemptId));
  });

  it("cancels a pending flow and ignores a late credential result", async () => {
    const status = deferred<api.ModelServerLoginStatus>();
    vi.mocked(api.modelserverLoginStatus).mockReturnValue(status.promise);
    const { onConnected } = setup();
    fireEvent.click(screen.getByRole("button", { name: "使用网页登录" }));
    await screen.findByLabelText("ModelServer 面板地址");
    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    expect(api.cancelModelServerLogin).toHaveBeenCalledWith(flow.attemptId);
    await act(async () => status.resolve({ status: "complete", refreshToken: "late-refresh" }));
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("cancels when the form closes before the native start command resolves", async () => {
    const started = deferred<api.ModelServerLoginStart>();
    vi.mocked(api.startModelServerLogin).mockReturnValue(started.promise);
    const { unmount } = setup();
    fireEvent.click(screen.getByRole("button", { name: "使用网页登录" }));
    unmount();
    await act(async () => started.resolve(flow));
    expect(api.cancelModelServerLogin).toHaveBeenCalledWith(flow.attemptId);
    expect(api.modelserverLoginStatus).not.toHaveBeenCalled();
  });

  it("ignores a stale reopen result after the flow is cancelled", async () => {
    const opened = deferred<void>();
    vi.mocked(api.openModelServerLogin).mockReturnValue(opened.promise);
    vi.mocked(api.modelserverLoginStatus).mockReturnValue(new Promise(() => {}));
    setup();
    fireEvent.click(screen.getByRole("button", { name: "使用网页登录" }));
    await screen.findByLabelText("ModelServer 面板地址");
    fireEvent.click(screen.getByRole("button", { name: "打开登录窗口" }));
    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    await act(async () => opened.reject("迟到错误"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports a failed flow and permits retry while preserving an existing credential", async () => {
    vi.mocked(api.modelserverLoginStatus)
      .mockResolvedValueOnce({ status: "failed", message: "登录窗口已关闭" })
      .mockReturnValue(new Promise(() => {}));
    setup(true);
    fireEvent.click(screen.getByRole("button", { name: "重新网页登录" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "登录窗口已关闭");
    expect(screen.getByText(/已填写 refresh_token/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新网页登录" }));
    await screen.findByLabelText("ModelServer 面板地址");
    expect(api.startModelServerLogin).toHaveBeenCalledTimes(2);
  });
});

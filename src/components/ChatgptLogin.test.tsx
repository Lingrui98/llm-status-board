import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChatgptLogin from "./ChatgptLogin";
import * as api from "../api";

vi.mock("../api", () => ({
  startChatgptLogin: vi.fn(), openChatgptLogin: vi.fn(), chatgptLoginStatus: vi.fn(),
  cancelChatgptLogin: vi.fn(), discardChatgptAuth: vi.fn(),
}));
const flow = { attemptId: "fixture-attempt", authUrl: "https://auth.openai.com/oauth/authorize?state=fixture-state" };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.startChatgptLogin).mockResolvedValue(flow);
  vi.mocked(api.openChatgptLogin).mockResolvedValue(undefined);
  vi.mocked(api.cancelChatgptLogin).mockResolvedValue(undefined);
  vi.mocked(api.discardChatgptAuth).mockResolvedValue(undefined);
});
function setup(authId?: string) {
  const onConnected = vi.fn(), onDisconnect = vi.fn(), onBusyChange = vi.fn();
  const rendered = render(<ChatgptLogin authId={authId} onConnected={onConnected} onDisconnect={onDisconnect} onBusyChange={onBusyChange} />);
  return { ...rendered, onConnected, onDisconnect, onBusyChange };
}

describe("ChatGPT browser login without a local Codex installation", () => {
  it("opens the official flow and passes only the native credential reference to the form", async () => {
    vi.mocked(api.chatgptLoginStatus).mockResolvedValue({ status: "complete", authId: "native-session", accountId: "workspace" });
    const { onConnected } = setup();
    fireEvent.click(screen.getByRole("button", { name: "使用 ChatGPT 登录" }));
    await waitFor(() => expect(onConnected).toHaveBeenCalledWith("native-session", "workspace"));
    expect(api.openChatgptLogin).toHaveBeenCalledWith(flow.attemptId);
    expect(screen.queryByLabelText("ChatGPT 登录链接")).toBeNull();
  });

  it("keeps a copyable link when automatic browser opening fails", async () => {
    vi.mocked(api.chatgptLoginStatus).mockReturnValue(new Promise(() => {}));
    vi.mocked(api.openChatgptLogin).mockRejectedValue("浏览器未打开");
    setup();
    fireEvent.click(screen.getByRole("button", { name: "使用 ChatGPT 登录" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "浏览器未打开");
    expect((screen.getByLabelText("ChatGPT 登录链接") as HTMLInputElement).value).toBe(flow.authUrl);
    expect(screen.getByRole("button", { name: "复制登录链接" })).toBeTruthy();
    expect(screen.getByText(/最多 5 分钟/)).toBeTruthy();
  });

  it("cancels a pending flow and discards a late successful callback", async () => {
    const status = deferred<api.ChatgptLoginStatus>();
    vi.mocked(api.chatgptLoginStatus).mockReturnValue(status.promise);
    const { onConnected } = setup();
    fireEvent.click(screen.getByRole("button", { name: "使用 ChatGPT 登录" }));
    await screen.findByLabelText("ChatGPT 登录链接");
    fireEvent.click(screen.getByRole("button", { name: "取消登录" }));
    expect(api.cancelChatgptLogin).toHaveBeenCalledWith(flow.attemptId);
    await act(async () => status.resolve({ status: "complete", authId: "late-session", accountId: null }));
    expect(onConnected).not.toHaveBeenCalled();
    expect(api.discardChatgptAuth).toHaveBeenCalledWith("late-session");
  });

  it("cancels even if the form closes before the native start command resolves", async () => {
    const started = deferred<api.ChatgptLoginStart>();
    vi.mocked(api.startChatgptLogin).mockReturnValue(started.promise);
    const { unmount } = setup();
    fireEvent.click(screen.getByRole("button", { name: "使用 ChatGPT 登录" }));
    unmount();
    await act(async () => started.resolve(flow));
    expect(api.cancelChatgptLogin).toHaveBeenCalledWith(flow.attemptId);
    expect(api.openChatgptLogin).not.toHaveBeenCalled();
  });

  it("reports denied/expired flows and permits retry", async () => {
    vi.mocked(api.chatgptLoginStatus).mockResolvedValue({ status: "failed", message: "登录等待已超时" });
    setup();
    fireEvent.click(screen.getByRole("button", { name: "使用 ChatGPT 登录" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "登录等待已超时");
    await waitFor(() => expect((screen.getByRole("button", { name: "使用 ChatGPT 登录" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("disconnects a saved login through the form without starting a new authorization", () => {
    const { onDisconnect } = setup("saved-session");
    expect(screen.getByText(/ChatGPT 已连接/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "断开登录" }));
    expect(onDisconnect).toHaveBeenCalledOnce();
    expect(api.startChatgptLogin).not.toHaveBeenCalled();
  });
});

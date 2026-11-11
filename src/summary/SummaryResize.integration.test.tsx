import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SummaryPopup from "./SummaryPopup";
import { loadSummarySize } from "./summarySize";

const mocks = vi.hoisted(() => ({
  setSize: vi.fn().mockResolvedValue(undefined),
  nativeResize: vi.fn().mockResolvedValue(undefined),
  invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setSize: mocks.setSize, startResizeDragging: mocks.nativeResize }),
  LogicalSize: class { constructor(public width: number, public height: number) {} },
}));

function pointer(target: HTMLElement | Window, type: string, x = 400, y = 500, button = 0) {
  const event = new MouseEvent(type, { bubbles: true, screenX: x, screenY: y, button, buttons: type === "pointerup" ? 0 : 1 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(target, event);
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function setup(platform: string) {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  render(<SummaryPopup />);
  await screen.findByText("读取失败，可在主窗口重试");
  const grip = screen.getByTitle("拖拽调整浮层大小");
  grip.setPointerCapture = vi.fn();
  grip.hasPointerCapture = vi.fn(() => true);
  grip.releasePointerCapture = vi.fn();
  return grip;
}

describe("summary resize platform wiring", () => {
  it("macOS uses setSize and suppresses leave while dragging", async () => {
    const grip = await setup("MacIntel");
    pointer(grip, "pointerdown");
    expect(grip.setPointerCapture).toHaveBeenCalledWith(1);
    const shell = document.querySelector(".summary-shell")!;
    fireEvent.mouseLeave(shell);
    expect(mocks.invoke.mock.calls.filter(([cmd, args]) => cmd === "set_summary_pointer_inside" && args.inside === false)).toHaveLength(0);
    pointer(window, "pointermove", 440, 550);
    await waitFor(() => expect(mocks.setSize).toHaveBeenCalledWith(expect.objectContaining({ width: window.innerWidth + 40, height: window.innerHeight + 50 })));
    pointer(window, "pointerup", 440, 550);
    expect(mocks.nativeResize).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("set_summary_pointer_inside", { inside: false });
  });
  it("Windows keeps native resize even when the API merely resolves", async () => {
    const grip = await setup("Win32");
    pointer(grip, "pointerdown");
    await waitFor(() => expect(mocks.nativeResize).toHaveBeenCalledWith("SouthEast"));
    expect(mocks.setSize).not.toHaveBeenCalled();
    expect(grip.setPointerCapture).not.toHaveBeenCalled();
  });
  it("ignores secondary buttons", async () => {
    const grip = await setup("MacIntel");
    pointer(grip, "pointerdown", 400, 500, 2);
    expect(grip.setPointerCapture).not.toHaveBeenCalled();
    expect(mocks.nativeResize).not.toHaveBeenCalled();
  });
  it("saves the updated DOM viewport and restores it on remount", async () => {
    await setup("MacIntel");
    fireEvent(window, new Event("resize"));
    expect(loadSummarySize()).toEqual({ width: window.innerWidth, height: window.innerHeight });
    cleanup();
    await setup("MacIntel");
    await waitFor(() => expect(mocks.setSize).toHaveBeenCalledWith(expect.objectContaining(loadSummarySize()!)));
  });
});

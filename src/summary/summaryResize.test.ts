import { afterEach, describe, expect, it, vi } from "vitest";
import { startSummaryResize } from "./summaryResize";

let stop: (() => void) | undefined;
afterEach(() => { stop?.(); stop = undefined; vi.restoreAllMocks(); });

function setup(setSize = vi.fn().mockResolvedValue(undefined)) {
  const target = document.createElement("span");
  target.setPointerCapture = vi.fn();
  target.hasPointerCapture = vi.fn(() => true);
  target.releasePointerCapture = vi.fn();
  const end = vi.fn();
  stop = startSummaryResize(target, { pointerId: 1, screenX: 400, screenY: 500 },
    { width: 300, height: 360 }, setSize, end);
  return { target, setSize, end };
}
function pointer(type: string, x: number, y: number, pointerId = 1, buttons = 1, target: EventTarget = window) {
  const event = new MouseEvent(type, { screenX: x, screenY: y, buttons });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  target.dispatchEvent(event);
}

describe("macOS summary resize", () => {
  it("captures synchronously and uses logical screen deltas, not Retina pixels", async () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { target, setSize, end } = setup();
    expect(target.setPointerCapture).toHaveBeenCalledWith(1);
    pointer("pointermove", 450, 580);
    expect(setSize).toHaveBeenLastCalledWith({ width: 350, height: 440 });
    await Promise.resolve();
    pointer("pointerup", 460, 590, 1, 0);
    expect(setSize).toHaveBeenLastCalledWith({ width: 360, height: 450 });
    expect(end).toHaveBeenCalledTimes(1);
    pointer("pointermove", 900, 900);
    expect(setSize).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
  it("clamps dimensions and ignores unrelated pointers", async () => {
    const { setSize } = setup();
    pointer("pointermove", 900, 900, 2);
    expect(setSize).not.toHaveBeenCalled();
    pointer("pointermove", -900, -900);
    expect(setSize).toHaveBeenLastCalledWith({ width: 260, height: 300 });
    await Promise.resolve();
    pointer("pointermove", 3000, 3000);
    expect(setSize).toHaveBeenLastCalledWith({ width: 1200, height: 1200 });
  });
  it("serializes IPC, coalesces moves, and applies the final pointerup size", async () => {
    let resolve!: () => void;
    const setSize = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => { resolve = r; }))
      .mockResolvedValue(undefined);
    setup(setSize);
    pointer("pointermove", 410, 510);
    pointer("pointermove", 420, 520);
    pointer("pointerup", 430, 530, 1, 0);
    expect(setSize).toHaveBeenCalledTimes(1);
    resolve();
    await Promise.resolve();
    expect(setSize).toHaveBeenCalledTimes(2);
    expect(setSize).toHaveBeenLastCalledWith({ width: 330, height: 390 });
  });
  it.each(["pointercancel", "lostpointercapture", "blur", "Escape", "cleanup", "released-button"])("cleans up on %s", (reason) => {
    const { target, end, setSize } = setup();
    if (reason === "Escape") window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    else if (reason === "cleanup") stop?.();
    else if (reason === "blur") window.dispatchEvent(new Event("blur"));
    else if (reason === "released-button") pointer("pointermove", 400, 500, 1, 0);
    else pointer(reason, 400, 500, 1, 0, reason === "lostpointercapture" ? target : window);
    expect(end).toHaveBeenCalledTimes(1);
    expect(target.releasePointerCapture).toHaveBeenCalledWith(1);
    pointer("pointermove", 700, 700);
    expect(setSize).not.toHaveBeenCalled();
  });
  it("ends the drag and reports an IPC failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { end } = setup(vi.fn().mockRejectedValue(new Error("failed")));
    pointer("pointermove", 450, 550);
    await Promise.resolve();
    expect(end).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
});

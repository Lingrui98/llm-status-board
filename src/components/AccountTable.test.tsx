import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AccountTable from "./AccountTable";
import type { AccountConfig } from "../types";

const accounts: AccountConfig[] = ["Alpha", "Beta", "Gamma"].map((name) => ({
  id: name, name, kind: "aiHubMix", enabled: true, baseUrl: "https://aihubmix.com", apiKey: "test-key", token: "", username: "", password: "",
}));

class Pointer extends MouseEvent {
  isPrimary = true;
  pointerId = 1;
}

beforeEach(() => {
  vi.stubGlobal("PointerEvent", Pointer);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const row = this.closest<HTMLTableRowElement>("tr[data-account-id]");
    const rows = row ? [...row.parentElement!.children] : [];
    const y = row ? 140 + rows.indexOf(row) * 52 : 100;
    return { x: 0, y, left: 0, top: y, right: 1000, bottom: y + (row ? 52 : 240), width: 1000, height: row ? 52 : 240, toJSON() {} };
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(initial = accounts) {
  const actions = { onReorder: vi.fn(), onToggle: vi.fn(), onEdit: vi.fn(), onDuplicate: vi.fn(), onRemove: vi.fn() };
  const result = render(<AccountTable accounts={initial} {...actions} />);
  return { ...actions, rerender: (next: AccountConfig[]) => result.rerender(<AccountTable accounts={next} {...actions} />) };
}
async function startDrag(name = "Gamma", y = 270) {
  fireEvent.pointerDown(screen.getByRole("button", { name: new RegExp(`拖动排序 ${name}`) }), { button: 0, clientX: 20, clientY: y });
  fireEvent.pointerMove(document, { clientX: 20, clientY: y - 8 });
  await waitFor(() => expect(document.querySelector(".account-row-dragging")).not.toBeNull());
}
async function moveToFirst() {
  fireEvent.pointerMove(document, { clientX: 20, clientY: 160 });
  await waitFor(() => expect(document.querySelector("[data-account-id=Alpha].account-drop-before")).not.toBeNull());
}

describe("account drag sorting", () => {
  it("previews a move across several rows, then saves once on release", async () => {
    const { onReorder } = setup();
    expect(screen.queryByRole("button", { name: /^上移/ })).toBeNull();
    await startDrag();
    await moveToFirst();
    expect(onReorder).not.toHaveBeenCalled();
    fireEvent.pointerUp(document);
    await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(1));
    expect(onReorder.mock.calls[0][0].map((a: AccountConfig) => a.id)).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("Escape cancels the preview without saving", async () => {
    const { onReorder } = setup();
    await startDrag();
    await moveToFirst();
    fireEvent.keyDown(document, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(document.querySelector(".account-row-dragging")).toBeNull());
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("dropping outside the list cancels without saving", async () => {
    const { onReorder } = setup();
    await startDrag();
    await moveToFirst();
    fireEvent.pointerMove(document, { clientX: -200, clientY: 160 });
    await waitFor(() => expect(document.querySelector(".account-drop-before")).toBeNull());
    fireEvent.pointerUp(document);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("keeps the current account objects when data changes during a drag", async () => {
    const { onReorder, rerender } = setup();
    await startDrag();
    rerender(accounts.map((a) => a.id === "Gamma" ? { ...a, token: "rotated-during-drag", enabled: false } : a));
    await moveToFirst();
    fireEvent.pointerUp(document);
    await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(1));
    expect(onReorder.mock.calls[0][0][0]).toMatchObject({ id: "Gamma", token: "rotated-during-drag", enabled: false });
  });

  it("cancels rather than overwriting a concurrent account addition", async () => {
    const { onReorder, rerender } = setup();
    await startDrag();
    rerender([...accounts, { ...accounts[0], id: "Delta", name: "Delta" }]);
    await moveToFirst();
    fireEvent.pointerUp(document);
    await waitFor(() => expect(document.querySelector(".account-row-dragging")).toBeNull());
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("supports keyboard sorting without invoking row editing or row navigation", async () => {
    const { onReorder, onEdit } = setup();
    const handle = screen.getByRole("button", { name: /拖动排序 Beta/ });
    handle.focus();
    fireEvent.keyDown(handle, { key: " ", code: "Space" });
    await waitFor(() => expect(document.querySelector(".account-row-dragging")).not.toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(handle, { key: "ArrowUp", code: "ArrowUp" });
    await waitFor(() => expect(document.querySelector("[data-account-id=Alpha].account-drop-before")).not.toBeNull());
    fireEvent.keyDown(handle, { key: " ", code: "Space" });
    await waitFor(() => expect(onReorder).toHaveBeenCalledTimes(1));
    expect(onReorder.mock.calls[0][0].map((a: AccountConfig) => a.id)).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(onEdit).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(handle);
  });

  it("keeps account controls clickable and disables sorting for a single account", () => {
    const { onToggle, onEdit, onDuplicate, onRemove, onReorder } = setup([accounts[0]]);
    expect((screen.getByRole("button", { name: /拖动排序 Alpha/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "启用 Alpha" }));
    fireEvent.click(screen.getByRole("button", { name: "编辑" }));
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    expect(onToggle).toHaveBeenCalledWith("Alpha");
    expect(onEdit).toHaveBeenCalledWith(accounts[0]);
    expect(onDuplicate).toHaveBeenCalledWith(accounts[0]);
    expect(onRemove).toHaveBeenCalledWith("Alpha");
    expect(onReorder).not.toHaveBeenCalled();
  });
});

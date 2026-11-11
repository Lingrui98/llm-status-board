import { clampSummarySize, type SummarySize } from "./summarySize";

interface ResizeStart {
  pointerId: number;
  screenX: number;
  screenY: number;
}

/** macOS 的 tao 不支持 drag_resize_window。使用逻辑坐标，不乘 Retina 缩放因子。 */
export function startSummaryResize(
  target: HTMLElement,
  start: ResizeStart,
  initialSize: SummarySize,
  setSize: (size: SummarySize) => Promise<void>,
  onEnd: () => void,
): () => void {
  let ended = false;
  let writing = false;
  let pending: SummarySize | undefined;

  // IPC 串行发送，只保留最新目标，避免快速移动产生积压或旧尺寸覆盖新尺寸。
  const flush = async () => {
    if (writing) return;
    writing = true;
    try {
      while (pending) {
        const size = pending;
        pending = undefined;
        await setSize(size);
      }
    } catch (error) {
      pending = undefined;
      console.warn("无法调整用量总结窗口大小", error);
      finish();
    } finally {
      writing = false;
    }
  };
  const update = (event: PointerEvent) => {
    pending = clampSummarySize(
      initialSize.width + event.screenX - start.screenX,
      initialSize.height + event.screenY - start.screenY,
    );
    void flush();
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== start.pointerId) return;
    if ((event.buttons & 1) === 0) {
      finish();
      return;
    }
    update(event);
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== start.pointerId) return;
    update(event);
    finish();
  };
  const cancel = (event: PointerEvent) => {
    if (event.pointerId === start.pointerId) finish();
  };
  const key = (event: KeyboardEvent) => {
    if (event.key === "Escape") finish();
  };
  const finish = () => {
    if (ended) return;
    ended = true;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", finish);
    window.removeEventListener("keydown", key);
    target.removeEventListener("lostpointercapture", cancel);
    if (target.hasPointerCapture(start.pointerId)) target.releasePointerCapture(start.pointerId);
    onEnd();
  };

  // 必须在 pointerdown 的同步调用栈内捕获，不能等动态 import 完成。
  target.setPointerCapture(start.pointerId);
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", finish);
  window.addEventListener("keydown", key);
  target.addEventListener("lostpointercapture", cancel);
  return finish;
}

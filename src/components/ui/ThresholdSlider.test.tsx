// R14 终审 D-4：阈值控件的量程与展示契约。
// 关键回归点：配置里一个「合法但超出滑块量程」的值，必须在数字框里如实显示，
// 且渲染阶段不得回写配置（原实现用 clamp 后的值当展示值，会静默改写用户配置）。

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import ThresholdSlider from "./ThresholdSlider";

afterEach(cleanup);

function numberField(label: string): HTMLInputElement {
  return screen.getByLabelText(label, { selector: "input[type=number]" }) as HTMLInputElement;
}

function rangeField(label: string): HTMLInputElement {
  return screen.getByLabelText(label, { selector: "input[type=range]" }) as HTMLInputElement;
}

const LABEL = "低余额提醒阈值（USD 及其他法币）";

describe("ThresholdSlider：量程与真实值展示（D-4）", () => {
  it("量程内的值原样显示；渲染阶段不回写（onChange 不被调用）", () => {
    const onChange = vi.fn();
    render(<ThresholdSlider label={LABEL} value={25} min={0} max={10000} step={10} unit="USD" onChange={onChange} />);
    expect(numberField(LABEL).value).toBe("25");
    expect(rangeField(LABEL).value).toBe("25");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("量程内的大额合法值（5000）显示为 5000，不显示上界 100，且不触发 onChange", () => {
    const onChange = vi.fn();
    render(
      <ThresholdSlider label={LABEL} value={5000} min={0} max={10000} step={10} unit="USD" onChange={onChange} />,
    );
    expect(numberField(LABEL).value).toBe("5000"); // 关键：不是被夹成 100/10000
    expect(numberField(LABEL).value).not.toBe("100");
    expect(rangeField(LABEL).value).toBe("5000");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("超出滑块量程的合法配置值：数字框显示真实值、滑块停在边界、不静默改写", () => {
    const onChange = vi.fn();
    // 模拟旧版窄量程之外的合法配置（规格校验上限 100000，滑块量程 0..10000）
    render(
      <ThresholdSlider label={LABEL} value={50000} min={0} max={10000} step={10} unit="USD" onChange={onChange} />,
    );
    expect(numberField(LABEL).value).toBe("50000"); // 真实值如实显示
    expect(rangeField(LABEL).value).toBe("10000"); // 滑块几何位置夹到上界
    expect(onChange).not.toHaveBeenCalled(); // 渲染绝不回写
    expect(screen.getByText(/滑块已停在上\/下界/)).toBeTruthy(); // 如实告知
  });

  it("D-8：聚焦后失焦、不输入任何字符 → 不得触发 onChange（不得静默钳制配置）", () => {
    const onChange = vi.fn();
    render(
      <ThresholdSlider label={LABEL} value={50000} min={0} max={10000} step={10} unit="USD" onChange={onChange} />,
    );
    const field = numberField(LABEL);
    expect(field.value).toBe("50000");
    field.focus();
    expect(document.activeElement).toBe(field);
    field.blur(); // 未输入即失焦：修复前会 parse "50000" → clamp 到 10000 → emit(10000)
    expect(onChange).not.toHaveBeenCalled();
    expect(numberField(LABEL).value).toBe("50000"); // 真实值保持不变
  });

  it("D-8：Enter 提交未编辑文本同样不触发 onChange", () => {
    const onChange = vi.fn();
    render(
      <ThresholdSlider label={LABEL} value={50000} min={0} max={10000} step={10} unit="USD" onChange={onChange} />,
    );
    const field = numberField(LABEL);
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(numberField(LABEL).value).toBe("50000");
  });

  it("D-8：量程内值「聚焦→失焦」往返也不触发 onChange", () => {
    const onChange = vi.fn();
    render(<ThresholdSlider label={LABEL} value={25} min={0} max={10000} step={10} unit="USD" onChange={onChange} />);
    const field = numberField(LABEL);
    field.focus();
    field.blur();
    expect(onChange).not.toHaveBeenCalled();
    expect(numberField(LABEL).value).toBe("25");
  });

  it("D-8：显式改动文本后失焦仍照常提交（dirty 判断不能吞掉真实编辑）", () => {
    const onChange = vi.fn();
    render(
      <ThresholdSlider label={LABEL} value={50000} min={0} max={10000} step={10} unit="USD" onChange={onChange} />,
    );
    const field = numberField(LABEL);
    fireEvent.change(field, { target: { value: "8000" } });
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(8000);
  });

  it("D-8 边界：显式输入一个会被钳制的值仍然提交（用户确实改了）", () => {
    const onChange = vi.fn();
    render(
      <ThresholdSlider label={LABEL} value={50000} min={0} max={10000} step={10} unit="USD" onChange={onChange} />,
    );
    const field = numberField(LABEL);
    fireEvent.change(field, { target: { value: "99999" } }); // 与 displayValue 不同 → 视为编辑
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledWith(10000); // 主动编辑才做钳制
  });

  it("超量程提示的可达性结构保持（noticeId / aria-describedby / role=status / 文案）", () => {
    const onChange = vi.fn();
    render(
      <ThresholdSlider label={LABEL} value={50000} min={0} max={10000} step={10} unit="USD" onChange={onChange} />,
    );
    const notice = document.querySelector(".threshold-notice") as HTMLElement;
    expect(notice).toBeTruthy();
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toContain("当前值 50000 超出滑块范围 0–10000，滑块已停在上/下界；数值本身未被修改。");
    // 两个输入控件都通过 aria-describedby 指向该提示
    expect(rangeField(LABEL).getAttribute("aria-describedby")).toBe(notice.id);
    expect(numberField(LABEL).getAttribute("aria-describedby")).toBe(notice.id);
    expect(notice.id).toBeTruthy();
  });

  it("用户拖动滑块 → 按步进对齐后回调（主动操作才写配置）", () => {
    const onChange = vi.fn();
    render(<ThresholdSlider label={LABEL} value={100} min={0} max={10000} step={10} unit="USD" onChange={onChange} />);
    fireEvent.change(rangeField(LABEL), { target: { value: "250" } });
    expect(onChange).toHaveBeenCalledWith(250);
  });

  it("数字框输入新值并失焦：对齐步进后回调一次", () => {
    const onChange = vi.fn();
    render(<ThresholdSlider label={LABEL} value={100} min={0} max={10000} step={10} unit="USD" onChange={onChange} />);
    const field = numberField(LABEL);
    fireEvent.change(field, { target: { value: "1234" } });
    expect(onChange).not.toHaveBeenCalled(); // 打字期间不提交
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(1230); // 对齐到 step=10
    expect(numberField(LABEL).value).toBe("1230");
  });

  it("数字框输入越界值：夹到量程内再回调（用户主动输入才做约束）", () => {
    const onChange = vi.fn();
    render(<ThresholdSlider label={LABEL} value={100} min={0} max={10000} step={10} unit="USD" onChange={onChange} />);
    const field = numberField(LABEL);
    fireEvent.change(field, { target: { value: "999999" } });
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledWith(10000);
  });

  it("非法输入回退为当前真实值，不回调", () => {
    const onChange = vi.fn();
    render(<ThresholdSlider label={LABEL} value={42} min={0} max={10000} step={10} unit="USD" onChange={onChange} />);
    const field = numberField(LABEL);
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.blur(field);
    expect(onChange).not.toHaveBeenCalled();
    expect(numberField(LABEL).value).toBe("42");
  });

  it("外部值变化时同步显示（受控）", () => {
    const onChange = vi.fn();
    const view = render(
      <ThresholdSlider label={LABEL} value={7} min={0} max={10000} step={1} unit="USD" onChange={onChange} />,
    );
    expect(numberField(LABEL).value).toBe("7");
    view.rerender(
      <ThresholdSlider label={LABEL} value={700} min={0} max={10000} step={1} unit="USD" onChange={onChange} />,
    );
    expect(numberField(LABEL).value).toBe("700");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("min/max 传反也能正常工作；非有限 value 回退下界", () => {
    const onChange = vi.fn();
    render(<ThresholdSlider label={LABEL} value={50} min={100} max={0} step={10} unit="USD" onChange={onChange} />);
    expect(numberField(LABEL).value).toBe("50");
    expect(onChange).not.toHaveBeenCalled();
  });
});

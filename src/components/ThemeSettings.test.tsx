import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ThemeSettings from "./ThemeSettings";

afterEach(cleanup);

describe("ThemeSettings", () => {
  it("提供五种主题模式，并按模式显示对应配置", () => {
    const onChange = vi.fn();
    const { rerender } = render(<ThemeSettings settings={{}} onChange={onChange} />);
    for (const label of ["深色", "浅色", "跟随系统", "按固定时间", "按日出日落"]) {
      expect(screen.getByRole("radio", { name: label })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("radio", { name: "按固定时间" }));
    expect(onChange).toHaveBeenCalledWith({ themeMode: "scheduled" });

    rerender(<ThemeSettings settings={{ themeMode: "scheduled" }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("浅色主题开始时间"), { target: { value: "06:30" } });
    expect(onChange).toHaveBeenCalledWith({ themeLightTime: "06:30" });

    rerender(<ThemeSettings settings={{ themeMode: "sunrise", themeLatitude: 31.2, themeLongitude: 121.5 }} onChange={onChange} />);
    expect(screen.getByLabelText("纬度")).toBeTruthy();
    expect(screen.getByLabelText("经度")).toBeTruthy();
    expect(screen.getByText(/默认坐标为 0, 0/)).toBeTruthy();
    const latitude = screen.getByLabelText("纬度");
    fireEvent.change(latitude, { target: { value: "-31.2" } });
    fireEvent.blur(latitude);
    expect(onChange).toHaveBeenCalledWith({ themeLatitude: -31.2 });
  });
});

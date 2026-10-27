import { useEffect, useState } from "react";
import type { SegmentedOption } from "./ui";
import { SegmentedControl, SettingRow } from "./ui";
import { resolveThemeSettings, type ThemeMode, type ThemeSettings as ThemeSettingsConfig } from "../theme";

export interface ThemeSettingsProps {
  /** 当前主题字段。组件不持有草稿，也不直接保存配置。 */
  settings: ThemeSettingsConfig;
  /** 用户修改一个字段时调用。 */
  onChange: (patch: Partial<ThemeSettingsConfig>) => void;
  disabled?: boolean;
}

const THEME_MODE_OPTIONS: readonly SegmentedOption<ThemeMode>[] = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "system", label: "跟随系统" },
  { value: "scheduled", label: "按固定时间" },
  { value: "sunrise", label: "按日出日落" },
];

interface CoordinateSettingProps {
  label: "纬度" | "经度";
  hint: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (value: number | null) => void;
}

/** 经纬度在失焦时提交，输入负号和小数点的中间态不会触发配置校验。 */
function CoordinateSetting({ label, hint, value, min, max, disabled, onChange }: CoordinateSettingProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => onChange(draft.trim() === "" ? null : Number(draft));
  return (
    <SettingRow
      label={label}
      hint={hint}
      disabled={disabled}
      control={(a11y) => (
        <input
          id={a11y.id}
          aria-describedby={a11y.describedBy}
          type="number"
          inputMode="decimal"
          min={min}
          max={max}
          step="any"
          value={draft}
          disabled={a11y.disabled}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
      )}
    />
  );
}

/** 受控主题设置分区。父组件负责合并 patch、校验和保存。 */
export function ThemeSettings({ settings, onChange, disabled = false }: ThemeSettingsProps) {
  const values = resolveThemeSettings(settings);

  return (
    <section className="settings-section theme-settings" id="settings-appearance" aria-label="主题设置">
      <h3>外观与主题</h3>
      <div className="set-rows">
        <SettingRow
          label="外观模式"
          hint="选择固定外观，或让应用按环境自动切换"
          disabled={disabled}
          control={
            <SegmentedControl
              options={THEME_MODE_OPTIONS}
              value={values.themeMode}
              onChange={(themeMode) => onChange({ themeMode })}
              ariaLabel="主题模式"
              disabled={disabled}
            />
          }
        />

        {values.themeMode === "scheduled" && (
          <>
            <SettingRow
              label="浅色主题开始时间"
              hint="到达此时间后切换为浅色"
              disabled={disabled}
              control={(a11y) => (
                <input
                  id={a11y.id}
                  aria-describedby={a11y.describedBy}
                  type="time"
                  value={values.themeLightTime}
                  disabled={a11y.disabled}
                  onChange={(event) => onChange({ themeLightTime: event.target.value })}
                />
              )}
            />
            <SettingRow
              label="深色主题开始时间"
              hint="到达此时间后切换为深色"
              disabled={disabled}
              control={(a11y) => (
                <input
                  id={a11y.id}
                  aria-describedby={a11y.describedBy}
                  type="time"
                  value={values.themeDarkTime}
                  disabled={a11y.disabled}
                  onChange={(event) => onChange({ themeDarkTime: event.target.value })}
                />
              )}
            />
          </>
        )}

        {values.themeMode === "sunrise" && (
          <>
            <CoordinateSetting
              label="纬度"
              hint="北纬为正，南纬为负；范围 -90–90。失焦后保存"
              value={values.themeLatitude}
              min={-90}
              max={90}
              disabled={disabled}
              onChange={(themeLatitude) => onChange({ themeLatitude })}
            />
            <CoordinateSetting
              label="经度"
              hint="东经为正，西经为负；范围 -180–180。失焦后保存"
              value={values.themeLongitude}
              min={-180}
              max={180}
              disabled={disabled}
              onChange={(themeLongitude) => onChange({ themeLongitude })}
            />
          </>
        )}
      </div>

      {values.themeMode === "scheduled" && (
        <p className="muted small">两个时间均使用本机本地时间。浅色时段可以跨越午夜。</p>
      )}
      {values.themeMode === "sunrise" && (
        <p className="muted small">
          应用根据本机日期和经纬度估算日出日落。默认坐标为 0, 0，请填写实际位置。极昼时保持浅色，极夜时保持深色。
        </p>
      )}
    </section>
  );
}

export default ThemeSettings;

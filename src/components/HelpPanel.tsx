import { useState } from "react";
import type { ProviderKind } from "../types";
import { PROVIDER_KINDS } from "../types";
import DetailDrawer from "./DetailDrawer";
import CredentialHelp from "./CredentialHelp";

/**
 * 打包期回退版本号 —— **仅**当运行时 getVersion() 不可用（jsdom / 浏览器预览）时使用。
 * 正常运行版本以 App 传入的 appVersion（唯一事实来源：tauri.conf.json）为准，
 * 发版不再需要手工同步本常量（R22 修复：此前硬编码 "0.1.3" 已与实际版本脱节）。
 */
export const APP_VERSION = "0.2.5";

interface Props {
  /** 运行时版本号（App 层查询自 tauri.conf.json）；缺省回退到打包期常量 */
  appVersion?: string;
  onClose: () => void;
  /** 重新打开新手引导（App 会同时关闭本面板） */
  onOpenGuide: () => void;
}

/** 快捷键总表：与 App / CommandPalette / SettingsView 的实际绑定一一对应 */
const SHORTCUTS: { keys: React.ReactNode; desc: string }[] = [
  {
    keys: (
      <>
        <kbd>Ctrl</kbd>+<kbd>K</kbd> / <kbd>Ctrl</kbd>+<kbd>P</kbd>
      </>
    ),
    desc: "打开 / 关闭命令面板",
  },
  {
    keys: (
      <>
        <kbd>1</kbd>–<kbd>9</kbd>
      </>
    ),
    desc: "打开第 N 个启用账号的详情（看板视图）",
  },
  { keys: <kbd>ESC</kbd>, desc: "关闭命令面板 / 详情抽屉 / 帮助面板" },
  {
    keys: (
      <>
        <kbd>↑</kbd>
        <kbd>↓</kbd> + <kbd>Enter</kbd>
      </>
    ),
    desc: "命令面板内选择并执行",
  },
  {
    keys: (
      <>
        <kbd>Tab</kbd> → <kbd>↑</kbd>
        <kbd>↓</kbd> → <kbd>Enter</kbd>
      </>
    ),
    desc: "设置页账号表格的行导航与编辑",
  },
];

/**
 * 常驻帮助面板（右侧抽屉，复用 DetailDrawer 的交互模型）：
 * 快捷键总表 + 凭证获取帮助（按类型）+ 重开新手引导 + 关于。
 */
export default function HelpPanel({ appVersion, onClose, onOpenGuide }: Props) {
  const [kind, setKind] = useState<ProviderKind>("newApi");
  // 运行时版本优先，打包期常量兜底（jsdom / 浏览器预览）
  const version = appVersion ?? APP_VERSION;

  return (
    <DetailDrawer title="帮助" subtitle={`v${version}`} onClose={onClose}>
      <section className="help-section">
        <h4>快捷键</h4>
        <table className="help-kbd-table">
          <tbody>
            {SHORTCUTS.map((s, i) => (
              <tr key={i}>
                <td className="help-kbd-cell">{s.keys}</td>
                <td>{s.desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="help-section">
        <h4>凭证获取帮助</h4>
        <p className="muted small help-section-note">选择账号类型，查看对应的凭证获取步骤：</p>
        <select
          className="help-select"
          value={kind}
          onChange={(e) => setKind(e.target.value as ProviderKind)}
          aria-label="选择提供商类型查看凭证教程"
        >
          {[...new Set(PROVIDER_KINDS.map((k) => k.group))].map((group) => (
            <optgroup key={group} label={group}>
              {PROVIDER_KINDS.filter((k) => k.group === group).map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        <div className="help-cred">
          <CredentialHelp kind={kind} />
        </div>
      </section>

      <section className="help-section">
        <h4>新手引导</h4>
        <p className="muted small help-section-note">第一次使用时展示的四步上手引导，可随时重看：</p>
        <button type="button" className="btn ghost" onClick={onOpenGuide}>
          重新打开新手引导
        </button>
      </section>

      <section className="help-section help-about">
        <h4>关于</h4>
        <p>LLM Status Board v{version} —— 聚合展示 LLM 提供商 / 中转站的余额与用量。</p>
        <p>
          数据直接来自各家提供商接口，仅保存在本机配置文件；API Key / Token 不会上传到任何第三方服务器。
        </p>
        <p className="muted small">新版本检查与一键更新在「设置 → 关于与更新」。</p>
      </section>
    </DetailDrawer>
  );
}

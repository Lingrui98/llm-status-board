import { useEffect, useState } from "react";
import type { AccountConfig, AppConfig, ProviderKind, Settings } from "../types";
import { PROVIDER_KINDS, DEFAULT_BASE_URLS, newAccountId } from "../types";
import { moveAccount } from "../configMerge";
import AccountForm from "./AccountForm";
import ThresholdSlider from "./ui/ThresholdSlider";
import { InlineNotice, SegmentedControl, SettingRow } from "./ui";
import { DEFAULT_NOTIFY_THRESHOLDS, resolveAlertSettings } from "../notifications";
import { isSystemNotifyEnabled, resolveQuotaDetailDisplay } from "../residentSettings";
import { NOTIFY_PERMISSION_RETRY_LABEL, notificationManualPath } from "../pluginRuntime";
import { exportUsageCsv } from "../exportReport";
import { formatProgress, isUpdateBusy, shortUpdateDate, type UpdateState } from "../updater";
import * as api from "../api";

/** R16 自启状态（§2）：真值以系统为准，查询中禁用开关 */
export interface AutostartState {
  /** 系统真实状态（isEnabled() 查询结果） */
  enabled: boolean;
  /** 正在查询/切换 → 开关禁用 */
  busy: boolean;
  /** 查询或切换失败的可读原因 */
  error?: string | null;
}

interface Props {
  config: AppConfig;
  /** 任何配置变更立即调用（App 层乐观生效 + 防抖自动落盘），无手动保存按钮 */
  onSave: (config: AppConfig) => void;
  /** 「刷新数据」：App 会先把待保存变更落盘再刷新 */
  onRefresh: () => Promise<void>;
  /** 外部「添加账号（预选类型）」请求（新手引导 / 空状态步骤），nonce 判重 */
  addRequest?: { kind: ProviderKind; nonce: number } | null;
  /** 请求被消费后调用，App 据此清除（防重挂载复开表单） */
  onAddRequestHandled?: () => void;
  /** 自动保存状态（App 层驱动）：saving / saved（短暂浮现）/ error（可重试） */
  saveState: "idle" | "saving" | "saved" | "error";
  saveError?: string;
  onRetrySave?: () => void;
  /* ---- R16 ---- */
  /** 自启真实状态与忙碌标志（App 层拥有，设置页只读渲染 + 发起切换） */
  autostart?: AutostartState;
  /** 请求切换开机自启（App 层执行 enable/disable 并复查真实状态） */
  onToggleAutostart?: (next: boolean) => void;
  /** 系统通知权限状态（由 App 查询；'unknown' = 查询失败） */
  notifyPermission?: "granted" | "denied" | "unknown";
  /** 用户点「重新请求授权」：请求一次通知权限（不会打开系统设置页，故文案如实描述） */
  onRequestNotifyPermission?: () => void;
  /* ---- R22 一键更新 ---- */
  /** 更新状态机（App 层拥有；不传 = 未接更新能力，区块仍显示版本与开关） */
  updateState?: UpdateState;
  /** 运行时版本号（空串/缺省 = 查询失败，显示「未知」而不是编造版本） */
  appVersion?: string;
  /** 手动「检查更新」 */
  onCheckUpdate?: () => void;
  /** 「立即更新」：下载并安装已发现的更新 */
  onInstallUpdate?: () => void;
  /** 安装完成后重启进新版 */
  onRelaunchAfterUpdate?: () => void;
  /** 兜底：系统浏览器打开 GitHub 发布页 */
  onOpenReleasePage?: () => void;
}

/**
 * R14 设置校验：阈值/窗口越界或非整数一律拒绝落盘，返回可读中文原因。
 * 判定用非法值优先：组件层面已钳制，这里是「保存前最后一道闸」（AC-9）。
 */
export function validateSettings(settings: Settings): { ok: true } | { ok: false; message: string } {
  const { notifyLowBalanceUsd: usd, notifyLowBalanceCny: cny, notifyQuotaPercent: quota, insightWindowDays: days } =
    settings;
  if (usd != null && (!Number.isFinite(usd) || usd < 0 || usd > 10000))
    return { ok: false, message: "低余额提醒阈值（USD）需在 0–10000 之间" };
  if (cny != null && (!Number.isFinite(cny) || cny < 0 || cny > 100000))
    return { ok: false, message: "低余额提醒阈值（CNY）需在 0–100000 之间" };
  if (quota != null && (!Number.isFinite(quota) || quota < 1 || quota > 100 || !Number.isInteger(quota)))
    return { ok: false, message: "配额用量提醒线需为 1–100 的整数" };
  if (days != null && (!Number.isFinite(days) || days < 3 || days > 90 || !Number.isInteger(days)))
    return { ok: false, message: "洞察统计窗口需为 3–90 的整数天" };
  // R16：自动重试次数 0–3 整数（Rust 侧 validate_settings 同步）
  const retryMax = settings.refreshRetryMax;
  if (retryMax != null && (!Number.isFinite(retryMax) || retryMax < 0 || retryMax > 3 || !Number.isInteger(retryMax)))
    return { ok: false, message: "自动重试次数需为 0–3 的整数" };
  // R23：限额窗口明细显示方式白名单（Rust 侧 validate_settings 同步）
  const qdd = settings.quotaDetailDisplay;
  if (qdd != null && qdd !== "percent" && qdd !== "raw")
    return { ok: false, message: "限额窗口明细显示方式只支持 percent / raw" };
  return { ok: true };
}

/** R16：Settings → 自动重试配置（旧配置缺字段 → 规格默认：启用 + 1 次） */
export { resolveRetrySettings, isSystemNotifyEnabled } from "../residentSettings";

export default function SettingsView({
  config,
  onSave,
  onRefresh,
  addRequest,
  onAddRequestHandled,
  saveState,
  saveError,
  onRetrySave,
  autostart,
  onToggleAutostart,
  notifyPermission = "unknown",
  onRequestNotifyPermission,
  updateState,
  appVersion,
  onCheckUpdate,
  onInstallUpdate,
  onRelaunchAfterUpdate,
  onOpenReleasePage,
}: Props) {
  // 不再持有本地草稿：列表/通用设置全部直接读写 config（App 层 state），
  // 每次变更经 onSave 走自动保存通道 —— 不存在「忘了点保存」的状态
  const accounts = config.accounts;
  const [editing, setEditing] = useState<AccountConfig | null>(null); // null=列表, {}=新增
  const [savedTip, setSavedTip] = useState("");
  const [cfgPath, setCfgPath] = useState<string>("");
  const [exportBusy, setExportBusy] = useState(false);
  // R14：提醒阈值（配置已解析出默认值，供滑块直接受控使用）
  const alerts = resolveAlertSettings(config.settings);

  // R22：更新状态 → 版本行徽标（一目了然；详细状态在区块下方内联展示）
  const updateBadge = !updateState
    ? undefined
    : updateState.kind === "available"
      ? `v${updateState.info.version} 可更新`
      : updateState.kind === "ready"
        ? "待重启"
        : updateState.kind === "checking"
          ? "检查中"
          : updateState.kind === "downloading"
            ? "下载中"
            : updateState.kind === "up-to-date"
              ? "已最新"
              : updateState.kind === "error"
                ? "更新失败"
                : undefined;
  const updateBadgeTone: "default" | "ok" | "warn" | "err" =
    updateState?.kind === "available" || updateState?.kind === "ready"
      ? "warn"
      : updateState?.kind === "up-to-date"
        ? "ok"
        : updateState?.kind === "error"
          ? "err"
          : "default";
  const updateBusy = updateState ? isUpdateBusy(updateState) : false;

  useEffect(() => {
    api.configPath().then(setCfgPath).catch(() => {});
  }, []);

  const showTip = (msg: string) => {
    setSavedTip(msg);
    window.setTimeout(() => setSavedTip(""), 2500);
  };

  const updateAccounts = (next: AccountConfig[]) => onSave({ ...config, accounts: next });

  // R14：任何设置变更先过校验（阈值越界 / 非整数一律拒绝落盘，AC-9）
  const updateSettings = (patch: Partial<Settings>) => {
    const nextSettings: Settings = { ...config.settings, ...patch };
    const result = validateSettings(nextSettings);
    if (result.ok) onSave({ ...config, settings: nextSettings });
    else showTip(`保存失败：${result.message}`);
  };

  const addAccount = (kind: ProviderKind = "newApi") => {
    setEditing({
      id: newAccountId(),
      name: "",
      kind,
      enabled: true,
      baseUrl: DEFAULT_BASE_URLS[kind],
      apiKey: "",
      token: "",
      userId: null,
      username: "",
      password: "",
      quotaPerUnit: null,
      custom: null,
    });
  };

  // 消费外部「添加账号（预选类型）」请求：打开表单后通知 App 清除，避免切视图重挂载时复开
  useEffect(() => {
    if (addRequest) {
      addAccount(addRequest.kind);
      onAddRequestHandled?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addRequest, onAddRequestHandled]);

  const upsertAccount = (acc: AccountConfig) => {
    const i = accounts.findIndex((a) => a.id === acc.id);
    if (i >= 0) {
      const copy = [...accounts];
      copy[i] = acc;
      updateAccounts(copy);
    } else {
      updateAccounts([...accounts, acc]);
    }
    setEditing(null);
  };

  const removeAccount = (id: string) => {
    updateAccounts(accounts.filter((a) => a.id !== id));
  };

  const toggleEnabled = (id: string) => {
    updateAccounts(accounts.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)));
  };

  const duplicateAccount = (acc: AccountConfig) => {
    updateAccounts([...accounts, { ...acc, id: newAccountId(), name: acc.name + " 副本" }]);
  };

  const move = (id: string, dir: -1 | 1) => {
    const next = moveAccount(accounts, id, dir);
    if (next !== accounts) updateAccounts(next);
  };

  // 表格行键盘导航：↑↓ 在行间移动焦点，Enter/Space 打开编辑（仅当焦点在行本身，不拦截行内按钮的原生行为）
  const onRowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>, acc: AccountConfig) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const rows = Array.from(e.currentTarget.parentElement?.querySelectorAll("tr") ?? []);
      const i = rows.indexOf(e.currentTarget);
      const next = rows[e.key === "ArrowDown" ? i + 1 : i - 1] as HTMLElement | undefined;
      next?.focus();
    } else if ((e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
      e.preventDefault();
      setEditing(acc);
    }
  };

  // 报表导出：按需拉取历史快照与上次结果（设置页不常驻这些数据，避免额外 props 传递）
  const handleExportCsv = async () => {
    setExportBusy(true);
    try {
      const [snapshots, outcomes] = await Promise.all([api.getHistory(), api.getLastResults()]);
      const result = await exportUsageCsv(config.accounts, outcomes, snapshots, {
        accountIds: config.accounts.filter((a) => a.enabled).map((a) => a.id),
      });
      if (result.status === "cancelled") return;
      if (result.status === "error") showTip(`报表导出失败：${result.message}`);
      else showTip(`已导出 ${result.rowCount} 行到 ${result.path}`);
    } catch (e) {
      showTip(`报表导出失败：${String(e)}`);
    } finally {
      setExportBusy(false);
    }
  };

  const handleExport = async () => {
    try {
      const path = await api.pickExportPath();
      if (!path) return;
      await api.exportConfig(path);
      showTip(`已导出到 ${path}`);
    } catch (e) {
      showTip(`导出失败：${String(e)}`);
    }
  };

  const handleImport = async () => {
    // 注意：不能用 window.confirm —— macOS WKWebView 下它不弹窗且返回 undefined
    const confirmed = await api.confirmDialog(
      "导入会替换通用设置，账号按 ID 合并（同 ID 覆盖、新 ID 追加），导入后立即自动保存。继续？",
    );
    if (!confirmed) return;
    try {
      const path = await api.pickImportPath();
      if (!path) return;
      const merged = await api.importConfig(path);
      onSave(merged); // 走自动保存通道（乐观生效 + 防抖落盘）
      showTip(`已导入 ${merged.accounts.length} 个账号`);
    } catch (e) {
      showTip(`导入失败：${String(e)}`);
    }
  };

  if (editing) {
    return (
      <main className="main">
        <div className="settings-header">
          <div className="settings-title-group">
            <button className="link-btn back-btn" onClick={() => setEditing(null)}>
              <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M6.5 1.8 3.3 5l3.2 3.2" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              返回账号列表
            </button>
            <h2>{accounts.some((a) => a.id === editing.id) ? "编辑账号" : "添加账号"}</h2>
          </div>
        </div>
        <AccountForm initial={editing} onSubmit={upsertAccount} onCancel={() => setEditing(null)} />
      </main>
    );
  }

  return (
    <main className="main">
      <div className="settings-header">
        <h2>账号管理</h2>
        <div className="settings-actions">
          <button className="btn ghost" onClick={() => addAccount()}>
            + 添加账号
          </button>
          <button className="btn ghost" onClick={() => onRefresh()} title="先把当前配置落盘，再刷新一次数据">
            刷新数据
          </button>
          <button className="btn ghost" onClick={handleImport} title="从导出的配置文件合并账号（跨设备迁移）">
            导入配置
          </button>
          <button className="btn ghost" onClick={handleExport} title="导出全部账号与设置（含 API Key）">
            导出配置
          </button>
          {/* 原「保存全部」按钮 → 自动保存状态指示器（所有变更即时落盘，无需手动保存） */}
          <span className={`save-status save-status-${saveState}`} role="status" aria-live="polite">
            {saveState === "saving" && "保存中…"}
            {saveState === "saved" && "✓ 已自动保存"}
            {saveState === "idle" && <span className="muted">变更会自动保存</span>}
            {saveState === "error" && (
              <>
                <span className="save-status-err" title={saveError}>
                  保存失败{saveError ? `：${saveError}` : ""}
                </span>
                <button type="button" className="link-btn" onClick={onRetrySave}>
                  重试
                </button>
              </>
            )}
          </span>
        </div>
      </div>

      {savedTip && <div className="save-tip">{savedTip}</div>}

      {cfgPath && (
        <p className="muted small config-path">
          配置文件：<code>{cfgPath}</code>
        </p>
      )}

      {accounts.length === 0 ? (
        <div className="empty-state">
          <p className="muted">还没有账号，点击「添加账号」开始。</p>
        </div>
      ) : (
        <div className="accounts-table-wrap">
          <table className="accounts-table">
            <thead>
              <tr>
                <th>启用</th>
                <th>名称</th>
                <th>类型</th>
                <th>Base URL</th>
                <th>认证</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a, index) => {
                const kindMeta = PROVIDER_KINDS.find((k) => k.value === a.kind);
                const authLabel = a.token
                  ? "Token"
                  : a.apiKey
                    ? "API Key"
                    : a.username
                      ? "账号密码"
                      : a.custom
                        ? "自定义"
                        : null;
                const displayName = a.name || "未命名账号";
                const atTop = index === 0;
                const atBottom = index === accounts.length - 1;
                return (
                  <tr
                    key={a.id}
                    className={a.enabled ? "" : "disabled-row"}
                    tabIndex={0}
                    onKeyDown={(e) => onRowKeyDown(e, a)}
                    aria-label={`账号 ${a.name || "未命名"}，回车编辑`}
                  >
                    <td>
                      <input
                        type="checkbox"
                        className="switch"
                        checked={a.enabled}
                        onChange={() => toggleEnabled(a.id)}
                        aria-label={`启用 ${displayName}`}
                        title={a.enabled ? "点击停用" : "点击启用"}
                      />
                    </td>
                    <td className="cell-name">{a.name || <span className="muted">（未命名）</span>}</td>
                    <td>
                      <span className={`badge ${kindMeta?.group === "官方" ? "badge-official" : "badge-relay"}`}>
                        {kindMeta?.label ?? a.kind}
                      </span>
                    </td>
                    <td className="cell-url" title={a.baseUrl}>
                      {a.baseUrl}
                    </td>
                    <td>
                      {authLabel ? <span className="badge badge-auth">{authLabel}</span> : <span className="muted">—</span>}
                    </td>
                    <td className="cell-actions">
                      {/* 上移/下移：aria-disabled 而非 disabled，边界时仍可聚焦（连续操作焦点不丢失） */}
                      <button
                        type="button"
                        className="link-btn"
                        aria-disabled={atTop}
                        aria-label={`上移 ${displayName}（当前第 ${index + 1} 位）`}
                        title={atTop ? "已在最前" : "上移一位"}
                        onClick={() => !atTop && move(a.id, -1)}
                      >
                        上移
                      </button>
                      <button
                        type="button"
                        className="link-btn"
                        aria-disabled={atBottom}
                        aria-label={`下移 ${displayName}（当前第 ${index + 1} 位）`}
                        title={atBottom ? "已在最后" : "下移一位"}
                        onClick={() => !atBottom && move(a.id, 1)}
                      >
                        下移
                      </button>
                      <button className="link-btn" onClick={() => setEditing(a)}>
                        编辑
                      </button>
                      <button className="link-btn" onClick={() => duplicateAccount(a)}>
                        复制
                      </button>
                      <button className="link-btn danger" onClick={() => removeAccount(a.id)}>
                        删除
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {accounts.length > 0 && (
        <p className="muted small table-kbd-hint">
          提示：<kbd>Tab</kbd> 聚焦行后 <kbd>↑</kbd>
          <kbd>↓</kbd> 移动，<kbd>Enter</kbd> 编辑；「上移 / 下移」调整看板卡片顺序，全部变更自动保存。
        </p>
      )}

      <div className="settings-section">
        <h3>通用设置</h3>
        <label className="setting-row column">
          <span>自动刷新间隔（秒，0 = 关闭）</span>
          <input
            type="number"
            min={0}
            max={86400}
            className="input-compact"
            value={config.settings.autoRefreshSec}
            onChange={(e) => updateSettings({ autoRefreshSec: Number(e.target.value) })}
          />
          <span className="muted small">设为 0 即关闭自动刷新；手动刷新（顶栏 / 总览条 / 托盘 / 本页「刷新数据」）不受影响</span>
        </label>
        <label className="setting-row">
          <span>启动时自动刷新一次</span>
          <input
            type="checkbox"
            className="switch"
            checked={config.settings.refreshOnStart}
            onChange={(e) => updateSettings({ refreshOnStart: e.target.checked })}
          />
        </label>
        <label className="setting-row column">
          <span>网络代理（可选，全部查询共用）</span>
          <input
            value={config.settings.proxy ?? ""}
            onChange={(e) => updateSettings({ proxy: e.target.value || null })}
            placeholder="http://127.0.0.1:7890 或 socks5://127.0.0.1:1080，留空使用环境代理（如有）"
          />
        </label>
        {/* R23：限额窗口明细显示方式（托盘菜单 + 悬停浮层共用；保存后托盘菜单即时重建） */}
        <div className="set-rows">
          <SettingRow
            label="限额窗口明细显示"
            hint="配额窗口（5h / 7d / 1d / 1m 等）在托盘菜单与悬停浮层里的呈现：百分比条 = 已用占比直条；原始数字 = 已用 / 上限金额（无金额数据的窗口仍显示百分比）"
            control={
              <SegmentedControl
                options={[
                  { value: "percent", label: "百分比条" },
                  { value: "raw", label: "原始数字" },
                ]}
                value={resolveQuotaDetailDisplay(config.settings)}
                onChange={(v) => updateSettings({ quotaDetailDisplay: v })}
                ariaLabel="限额窗口明细显示方式"
              />
            }
          />
        </div>
        <p className="muted small">
          访问 OpenAI 等境外官方接口通常需要代理；中转站和国内厂商一般直连即可。
          API Key / Token 只保存在本机配置文件中，不会上传到任何服务器（查询请求直连各提供商）。
        </p>
      </div>

      {/* R16：常驻与通知 —— 自启/托盘/系统通知/自动重试同组归置；改动即时自动保存 */}
      <div className="settings-section">
        <h3>常驻与通知</h3>
        <div className="set-rows">
          {/* §2 开机自启：真值以系统为准（查询中禁用），失败回滚由 App 层执行 */}
          <SettingRow
            label="开机自启"
            hint="登录系统后自动启动看板（自启即普通启动）"
            disabled={!autostart || autostart.busy}
            badge={!autostart || autostart.busy ? "查询中" : autostart.enabled ? "已开启" : "已关闭"}
            badgeTone={autostart?.enabled ? "ok" : "default"}
            control={(a) => (
              <input
                type="checkbox"
                className="switch"
                id={a.id}
                aria-describedby={a.describedBy}
                disabled={a.disabled}
                checked={autostart?.enabled ?? false}
                onChange={(e) => onToggleAutostart?.(e.target.checked)}
              />
            )}
          />

          {/* §1 关闭窗口 = 隐藏到托盘（R14 既有开关，移入常驻组） */}
          <SettingRow
            label="关闭窗口时最小化到系统托盘"
            hint="开启时点 ✕ 隐藏到托盘（退出请右键托盘图标选「退出」）；关闭后 ✕ 直接退出"
            control={(a) => (
              <input
                type="checkbox"
                className="switch"
                id={a.id}
                aria-describedby={a.describedBy}
                checked={config.settings.closeToTray ?? true}
                onChange={(e) => updateSettings({ closeToTray: e.target.checked })}
              />
            )}
          />

          {/* §4 系统通知开关（默认关；开关关闭时不请求权限、不发送） */}
          <SettingRow
            label="系统通知"
            hint="余额不足、配额将满、刷新失败时发系统通知；同一问题 24 小时内只提醒一次"
            badge={
              notifyPermission === "granted" ? "已授权" : notifyPermission === "denied" ? "未授权" : "未知"
            }
            badgeTone={notifyPermission === "granted" ? "ok" : notifyPermission === "denied" ? "warn" : "default"}
            control={(a) => (
              <input
                type="checkbox"
                className="switch"
                id={a.id}
                aria-describedby={a.describedBy}
                checked={isSystemNotifyEnabled(config.settings)}
                onChange={(e) => updateSettings({ systemNotifications: e.target.checked })}
              />
            )}
          />

          {/* §5 自动重试：开关 + 次数（0–3，越界拒绝保存） */}
          <SettingRow
            label="刷新失败时自动重试"
            hint="仅整轮失败（刷新出错，或全部账号都失败）才重试；部分失败不重试"
            control={(a) => (
              <input
                type="checkbox"
                className="switch"
                id={a.id}
                aria-describedby={a.describedBy}
                checked={config.settings.refreshRetryEnabled ?? true}
                onChange={(e) => updateSettings({ refreshRetryEnabled: e.target.checked })}
              />
            )}
          />
          <SettingRow
            label="自动重试次数上限"
            hint="0–3 次，间隔 1s / 2s / 4s（累计最长 7s）"
            disabled={!(config.settings.refreshRetryEnabled ?? true)}
            control={
              <ThresholdSlider
                label="自动重试次数上限"
                value={config.settings.refreshRetryMax ?? 1}
                min={0}
                max={3}
                step={1}
                unit="次"
                disabled={!(config.settings.refreshRetryEnabled ?? true)}
                onChange={(v) => updateSettings({ refreshRetryMax: v })}
              />
            }
          />
        </div>

        {/* §4 权限被拒：常驻（刻意不传 autoHideMs，err 也不会自动消退）。
            文案诚实性（task-27）：插件只能「重新请求授权」，**无法打开系统设置页**，
            因此按钮如实写「重新请求授权」，正文补上手动放行路径，让用户点完仍有下一步。 */}
        {isSystemNotifyEnabled(config.settings) && notifyPermission === "denied" && (
          <InlineNotice
            tone="err"
            title="系统通知已被系统拒绝"
            message={`系统拒绝了通知权限，提醒目前只能在应用内看到。${notificationManualPath()}`}
            action={
              onRequestNotifyPermission
                ? { label: NOTIFY_PERMISSION_RETRY_LABEL, onClick: onRequestNotifyPermission }
                : undefined
            }
          />
        )}

        {/* §2 自启失败：可读原因 + 重试（绝不显示"已开启"但实际未生效） */}
        {autostart?.error && (
          <InlineNotice tone="warn" message={autostart.error} />
        )}
      </div>

      {/* R14：提醒与洞察 —— 阈值从硬编码改为可配置，改动即时自动保存并在下一轮刷新生效 */}
      <div className="settings-section">
        <h3>提醒与洞察</h3>
        <label className="setting-row">
          <span>启用余额 / 配额提醒</span>
          <input
            type="checkbox"
            className="switch"
            checked={alerts.enabled}
            onChange={(e) => updateSettings({ notifyEnabled: e.target.checked })}
          />
        </label>
        <p className="muted small">
          关闭后不再产生「余额不足」「配额将满」提醒；「刷新失败」属于事实状态，始终保留。通知阈值改动在下一轮刷新即生效。
        </p>

        <ThresholdSlider
          label="低余额提醒阈值（USD 及其他法币）"
          value={alerts.lowBalanceUsd}
          min={0}
          max={10000}
          step={10}
          unit="USD"
          hint="低于该余额时提醒"
          disabled={!alerts.enabled}
          onChange={(v) => updateSettings({ notifyLowBalanceUsd: v })}
        />
        <ThresholdSlider
          label="低余额提醒阈值（CNY）"
          value={alerts.lowBalanceCny}
          min={0}
          max={100000}
          step={10}
          unit="CNY"
          hint="独立于 USD 阈值，不做汇率换算"
          disabled={!alerts.enabled}
          onChange={(v) => updateSettings({ notifyLowBalanceCny: v })}
        />
        <ThresholdSlider
          label="配额用量提醒线"
          value={alerts.quotaPercent}
          min={1}
          max={100}
          step={1}
          unit="%"
          hint="配额窗口用量达到该比例时提醒"
          disabled={!alerts.enabled}
          onChange={(v) => updateSettings({ notifyQuotaPercent: v })}
        />
        <ThresholdSlider
          label="洞察统计窗口"
          value={alerts.insightWindowDays}
          min={3}
          max={90}
          step={1}
          unit="天"
          hint="看板洞察区用最近多少天的快照估算日均消耗"
          onChange={(v) => updateSettings({ insightWindowDays: v })}
        />

        <div className="settings-actions insights-export-row">
          <button
            className="btn ghost"
            onClick={handleExportCsv}
            disabled={exportBusy}
            title="导出各账号每日用量与余额快照（CSV，含 UTF-8 BOM，Excel 可直接打开）"
          >
            {exportBusy ? "导出中…" : "导出用量 CSV"}
          </button>
          <span className="muted small">列：账号 / 类型 / 币种 / 日期 / 花费 / 请求数 / Token / 余额快照</span>
        </div>
      </div>

      {/* R22：关于与更新 —— 版本号 + 一键更新。状态由 App 层驱动，本区块只读渲染 + 发起动作；
          文案诚实性：Windows 安装器接管后本应用会被重启，「待重启」提示在 macOS 才是主路径（已注明）。 */}
      <div className="settings-section">
        <h3>关于与更新</h3>
        <div className="set-rows">
          <SettingRow
            label={`当前版本 ${appVersion ? `v${appVersion}` : "未知"}`}
            hint="从 GitHub Releases 检查并安装更新（签名校验自动完成）；更新检查与数据查询共用上方「通用设置」里的网络代理"
            badge={updateBadge}
            badgeTone={updateBadgeTone}
            control={(a) => (
              <button
                type="button"
                className="btn ghost"
                id={a.id}
                aria-describedby={a.describedBy}
                disabled={updateBusy || !onCheckUpdate}
                onClick={onCheckUpdate}
              >
                {updateState?.kind === "checking" ? "检查中…" : "检查更新"}
              </button>
            )}
          />
          <SettingRow
            label="启动时自动检查更新"
            hint="启动约 5 秒后静默检查一次；发现新版本只在顶栏提示（及系统通知，若已开启），不会自动下载"
            control={(a) => (
              <input
                type="checkbox"
                className="switch"
                id={a.id}
                aria-describedby={a.describedBy}
                checked={config.settings.autoCheckUpdate ?? true}
                onChange={(e) => updateSettings({ autoCheckUpdate: e.target.checked })}
              />
            )}
          />
        </div>

        {updateState?.kind === "up-to-date" && (
          <InlineNotice tone="info" message="已是最新版本。" autoHideMs={6000} />
        )}

        {updateState?.kind === "available" && (
          <InlineNotice tone="info">
            <span className="update-block">
              <span>
                <strong>发现新版本 v{updateState.info.version}</strong>
                {shortUpdateDate(updateState.info.date) && `（发布于 ${shortUpdateDate(updateState.info.date)}）`}
                ，可一键更新。
              </span>
              {updateState.info.notes.trim() && (
                <details className="update-notes">
                  <summary>更新说明</summary>
                  <pre>{updateState.info.notes.trim()}</pre>
                </details>
              )}
              <span className="update-actions">
                <button type="button" className="btn primary" onClick={onInstallUpdate} disabled={!onInstallUpdate}>
                  立即更新
                </button>
                <button type="button" className="btn ghost" onClick={onOpenReleasePage} disabled={!onOpenReleasePage}>
                  前往发布页
                </button>
              </span>
            </span>
          </InlineNotice>
        )}

        {/* 进度高频更新 → live="off"（与重试倒计时同一无障碍规则，状态变化由区块出现本身承担） */}
        {updateState?.kind === "downloading" && (
          <InlineNotice tone="info" live="off">
            <span className="update-block">
              <span>{formatProgress(updateState.received, updateState.total)}</span>
              <progress
                className="update-progress"
                max={updateState.total ?? undefined}
                value={updateState.received}
                aria-label="更新下载进度"
              />
              <span className="muted small">
                下载完成后自动安装；Windows 上安装器会接管并重启本应用，macOS 安装后需点「立即重启」。
              </span>
            </span>
          </InlineNotice>
        )}

        {updateState?.kind === "ready" && (
          <InlineNotice tone="info">
            <span className="update-block">
              <span>
                <strong>v{updateState.info.version} 已安装完成</strong>，重启后生效。
              </span>
              <span className="update-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={onRelaunchAfterUpdate}
                  disabled={!onRelaunchAfterUpdate}
                >
                  立即重启
                </button>
              </span>
            </span>
          </InlineNotice>
        )}

        {updateState?.kind === "error" && (
          <InlineNotice tone="err" title={updateState.phase === "check" ? "检查更新失败" : "更新失败"}>
            <span className="update-block">
              <span>{updateState.message}</span>
              <span className="update-actions">
                <button
                  type="button"
                  className="btn ghost"
                  onClick={updateState.phase === "check" ? onCheckUpdate : onInstallUpdate}
                >
                  重试
                </button>
                <button type="button" className="btn ghost" onClick={onOpenReleasePage} disabled={!onOpenReleasePage}>
                  前往发布页手动下载
                </button>
              </span>
            </span>
          </InlineNotice>
        )}
      </div>
    </main>
  );
}

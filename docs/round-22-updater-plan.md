# Round 22 计划：软件内一键更新（GitHub Releases）

## 0. 目标与结论

给应用加「一键更新」：软件内检查 GitHub 最新 Release → 发现新版本 → 一键下载安装 → 重启生效。
**采用官方 `tauri-plugin-updater` 方案**（方案 A），不自建更新器。

理由（对比见 §7）：
- 端到端签名校验（私钥签名、公钥内嵌应用），release 资产被篡改也装不进去；
- Windows（NSIS）/ macOS（.app.tar.gz）双平台都由插件接管安装，真正的「一键」；
- 现有 `release.yml` 用的是 `tauri-apps/tauri-action`，原生支持自动签名 + 生成 `latest.json` 并上传到 Release，CI 侧改动只有几行。

## 1. 整体流程

```
用户点「检查更新」（或启动时静默检查）
  → 前端 check()（走 settings.proxy 代理，见 §5）
  → 插件 GET https://github.com/Lingrui98/llm-status-board/releases/latest/download/latest.json
  → 插件比较 latest.json.version 与当前版本（tauri.conf.json 的 version）
     ├─ 无更新        → 「已是最新版本 v0.2.3」
     ├─ 有新版本 vX   → 展示版本号 + 更新日志 + 「立即更新」按钮
     │    → 点击 → downloadAndInstall(进度回调)
     │         → 下载 + 校验签名（插件内置，失败即中止不安装）
     │         → Windows：NSIS 安装器静默接管，自动重启到新版（currentUser 安装，无需管理员）
     │         → macOS：.app 就地替换 → 调 relaunch() 重启
     └─ 失败（网络/404/校验失败）→ 可读中文提示 + 「重试」+「前往发布页手动下载」
```

`latest.json` 由 CI 生成，内容形如：

```json
{
  "version": "0.2.4",
  "notes": "发布说明",
  "pub_date": "2026-10-23T...",
  "platforms": {
    "windows-x86_64":  { "url": ".../LLM.Status.Board_0.2.4_x64-setup.exe", "signature": "..." },
    "darwin-aarch64":  { "url": ".../LLM.Status.Board_aarch64.app.tar.gz",  "signature": "..." },
    "darwin-x86_64":   { "url": ".../LLM.Status.Board_x64.app.tar.gz",      "signature": "..." }
  }
}
```

## 2. 一次性准备（维护者手工，只做一次）

1. 生成签名密钥对（minisign）：
   ```bash
   npx tauri signer generate -w ~/.tauri/llm-status-board.key
   ```
   得到：私钥文件（含密码）、**公钥字符串**。
2. GitHub 仓库 → Settings → Secrets and variables → Actions，新增两个 secret：
   - `TAURI_SIGNING_PRIVATE_KEY` = 私钥文件内容
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = 私钥密码
3. 公钥写进 `tauri.conf.json`（见 §3），随代码提交。**私钥绝不入库。**
   私钥本地多处备份（丢了 = 老用户永远无法自动更新，只能手动装一次新版换新公钥）。

## 3. 配置与 Rust 侧改动

| 文件 | 改动 |
|---|---|
| `src-tauri/Cargo.toml` | + `tauri-plugin-updater = "2"`、`tauri-plugin-process = "2"`、`tauri-plugin-opener = "2"` |
| `package.json` | + `@tauri-apps/plugin-updater`、`@tauri-apps/plugin-process`、`@tauri-apps/plugin-opener`（版本与现有插件对齐 ^2） |
| `src-tauri/tauri.conf.json` | `bundle.createUpdaterArtifacts: true`；新增 `plugins.updater`：<br>`endpoints: ["https://github.com/Lingrui98/llm-status-board/releases/latest/download/latest.json"]`<br>`pubkey: "<§2 生成的公钥>"` |
| `src-tauri/src/lib.rs` | 注册三个插件：`tauri_plugin_updater::Builder::new().build()`、`tauri_plugin_process::init()`、`tauri_plugin_opener::init()` |
| `src-tauri/capabilities/default.json` | + `updater:default`、`process:default`（仅用到 relaunch）、`opener:allow-open-url`（scope glob 限定本仓库 releases，只用于兜底「前往发布页」）<br>实施注记：初稿用 shell 插件，后更正为 opener——shell 的 `open` 自 2.1 起废弃，且其 capability scope 只支持命令维度、URL 校验只能走 `plugins.shell.open` 正则；opener 原生支持按 URL glob 授权 |
| `.github/workflows/release.yml` | Build 步骤 env 增加两行：<br>`TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}`<br>`TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}`<br>tauri-action 检测到密钥后会自动：给 updater 产物签名 → 生成 `latest.json` → 随 draft release 上传（含 `.sig`）。其余不变。 |

> 版本号唯一事实来源仍是 `tauri.conf.json` 的 `version`；插件用它与 `latest.json` 比较。
> `package.json` / `Cargo.toml` 的版本照常保持同步（现有发布流程不变）。

## 4. 前端设计

### 4.1 模块分层（沿用 R16 既有模式：纯逻辑 + pluginRuntime 动态接线）

**新文件 `src/updater.ts`（纯逻辑，可单测，不依赖 Tauri）**

```ts
export interface UpdateInfo { version: string; notes: string; date: string; }
export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date"; current: string }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "ready" }                       // 已安装，待重启（macOS 必走；Windows 一般自动）
  | { kind: "error"; message: string; retryable: true };

export interface UpdaterApi {
  check(proxy: string | null): Promise<UpdateInfo | null>;   // null = 已最新
  downloadAndInstall(onProgress: (received: number, total: number | null) => void): Promise<void>;
  relaunch(): Promise<void>;
  openReleasePage(): Promise<void>;                          // opener.openUrl 兜底
}

export function updaterErrorMessage(e: unknown): string;     // 参照 autostartErrorMessage 的风格
export function formatProgress(received: number, total: number | null): string; // "1.2 / 3.4 MB" 或 "已下载 1.2 MB"
```

错误文案要点（诚实、可操作）：
- endpoint 404 / 无 latest.json →「暂未获取到更新信息（该 Release 可能尚未发布更新清单），请稍后重试」
- 网络失败 →「检查更新失败：网络不可达，可检查「通用设置」里的网络代理」
- 签名校验失败 →「更新包校验失败，已中止安装；请前往发布页手动下载」（不做任何写盘安装）
- macOS 写入 /Applications 无权限 → 提示拖回「应用程序」或手动下载

**`src/pluginRuntime.ts` 增补 `pluginUpdater`（动态 import + try/catch 降级，与 autostart 同模式）**

- `check(proxy)` → `import("@tauri-apps/plugin-updater")` 的 `check({ proxy: proxy ?? undefined, timeout: 15_000 })`；`update == null` 返回 null，否则取 `{ version, body, date }`。
- `downloadAndInstall` → `update.downloadAndInstall(event => ...)`，`Started.data.contentLength` 为 total（可能 undefined → null），`Progress.data.chunkLength` 累加为 received。
- `relaunch` → `import("@tauri-apps/plugin-process")` 的 `relaunch()`。
- `openReleasePage` → `import("@tauri-apps/plugin-opener")` 的 `open("https://github.com/Lingrui98/llm-status-board/releases/latest")`。

### 4.2 UI 入口

**主入口：设置页新增「关于与更新」区块**（放在「通用设置」之后，`SettingRow` + `InlineNotice` 复用现有组件）：

```
关于与更新
├─ 当前版本 v0.2.3        [检查更新]      ← 一行：版本号 + 按钮
├─ （检查后）内联状态：
│   ✓ 已是最新
│   ✦ 发现新版本 v0.2.4（2026-10-23）  [立即更新] [查看更新说明]   ← notes 折叠展示
│   ⏳ 正在下载 1.2 / 3.4 MB …（进度条，total 未知时转菊花）
│   ✓ 更新已就绪  [重启生效]
│   ✗ 错误文案  [重试] [前往发布页手动下载]
└─ [x] 启动时自动检查更新（settings.autoCheckUpdate，默认开）
```

**副入口：帮助面板「关于」区**加一行「当前版本 + 检查更新」链接（点击跳设置页对应区块）。
顺手修 bug：`HelpPanel.tsx` 的 `APP_VERSION = "0.1.3"` 已和实际版本（0.2.3）脱节 → 改为运行时 `getVersion()`（`@tauri-apps/api/app`）获取，单一事实来源。

### 4.3 启动时静默检查（默认开）

- App 启动后 ~5s 静默 `check()`：有更新 → 复用现有应用内通知中心发一条「发现新版本 vX，去设置页更新」（不自动下载）；
- 若系统通知开关已开且已授权，同步发一条系统通知（复用 R16 基建，24h 去重）；
- 失败完全静默（不打断启动，不写错误日志到 UI）。
- 「跳过此版本」列入 P2（记录 `skippedVersion` 到 config，命中即不提醒），首版不做。

### 4.4 状态归属

`UpdateState` 放 App 层（与 autostart 状态同款模式），SettingsView 通过 props 接收 + 回调（`onCheckUpdate` / `onInstallUpdate` / `onRelaunch`），保持 SettingsView 无直接插件依赖，测试继续用 vi.mock。

## 5. 代理兼容（本项目特有风险）

GitHub 在国内访问不稳定，而 updater 插件用自己的 HTTP client，**不吃** Rust 侧 reqwest 的全局代理。
处理：JS 侧 `check({ proxy })` 显式传入 `config.settings.proxy`（用户已在「通用设置」配代理的话，更新检查同样生效）；留空则走系统环境。文档与设置页提示中说明「更新检查与数据查询共用同一代理设置」。

## 6. 测试与验证

**自动化（随 PR 跑）**
- `src/updater.test.ts`：状态机迁移（idle→checking→available/up-to-date/error）、错误文案分支（404/网络/签名）、进度格式化（total null/有值）。
- SettingsView 区块渲染测试（mock UpdaterApi）：按钮禁用态、各状态文案、「立即更新」触发回调。
- `npm test` + `cargo test` + `npm run build` 全绿。

**手工验证（有「鸡生蛋」约束，如实说明）**
- v0.2.4 是首个带 `latest.json` 的 Release（它自己发布前，线上 latest.json 不存在 → 检查更新会走 404 分支，属预期）。
- 完整链路最早在 **v0.2.5** 验证：装着 v0.2.4 的机器点「检查更新」→ 一键更新到 v0.2.5。
- 想提前验证：本地把 `tauri.conf.json` version 临时改小（如 0.2.2），把 updater endpoint 临时指向一个**固定 tag 的测试 release**（`releases/download/vX-test/latest.json`，prerelease 不会被 `/latest/` 命中，故用固定 tag），`npm run tauri dev` 里走完整下载安装流程，验证后还原。
- v0.2.4 的 Release Notes 里写明：**v0.2.3 及更早版本没有更新功能，需最后手动下载安装一次**。

## 7. 备选方案（已否决）

- **方案 B：自建检查 + 跳浏览器下载**。只调 `repos/.../releases/latest` 比版本号，提示用户去网页下载。改动最小，但不是「一键」（用户手动下载安装），且无签名校验。否决。
- **方案 C：自建下载安装（reqwest + sha256 校验后启动安装器）**。可复用 Rust 全局代理，但 macOS 上无法自替换 .app（仍需用户拖 dmg），且等于重造 updater 插件的轮子（断点续传/原子替换/平台差异全要自己处理），安全性也不如 minisign 端到端签名。否决。

## 8. 改动文件清单（实施时按此执行）

| # | 文件 | 类型 |
|---|---|---|
| 1 | `package.json` | 改：+3 依赖 |
| 2 | `src-tauri/Cargo.toml` | 改：+3 依赖 |
| 3 | `src-tauri/tauri.conf.json` | 改：createUpdaterArtifacts + plugins.updater |
| 4 | `src-tauri/capabilities/default.json` | 改：+3 权限 |
| 5 | `src-tauri/src/lib.rs` | 改：注册 3 插件 |
| 6 | `src/updater.ts` | 新：纯逻辑状态机 + 文案 |
| 7 | `src/updater.test.ts` | 新：单测 |
| 8 | `src/pluginRuntime.ts` | 改：+pluginUpdater 接线 |
| 9 | `src/App.tsx` | 改：更新状态提升 + 启动静默检查 |
| 10 | `src/components/SettingsView.tsx` | 改：「关于与更新」区块 |
| 11 | `src/components/HelpPanel.tsx` | 改：版本号动态化（顺带修 0.1.3 脱节 bug） |
| 12 | `.github/workflows/release.yml` | 改：+2 env |
| 13 | `README.md` | 改：使用说明补「一键更新」条目 |

不在范围内（P2 以后再说）：跳过版本、增量更新（Tauri 暂不支持）、更新失败自动回滚（NSIS 安装失败本身不破坏旧版）。

## 9. 实施状态（2026-10-23）

已按 §8 全部落地（13 处文件改动 + `src/updater.test.ts` 20 条新用例）。门禁结果：

- `npm test`：26 文件 456 用例全绿（含 updater 20 条）
- `npm run build`（tsc + vite）：通过
- Rust 门禁（fmt / clippy / test）：本机无 Rust 工具链，未本地执行；Rust 侧改动已逐条对照 plugins-workspace v2 源码核实（updater `Builder::new().build()`、updater/process 的 `default` 权限集、opener 的 glob URL scope），推代码后由 ci.yml 双平台矩阵执行

实施中对初稿的两处修正：

1. **shell → opener**：shell 插件的 `open` 自 2.1 起废弃，且其 capability scope 只有命令维度（`{ name, cmd, args }`），初稿的 `{ "open": "正则" }` 条目会在构建期 schema 校验失败；URL 校验只能走 `plugins.shell.open` 配置。opener 插件原生支持 capability 级 URL glob 授权（`OpenerScopeEntry::Url { url, app }`），更严也更简单。
2. **设置区块位置**：「关于与更新」放在设置页**底部**（提醒与洞察之后），而非初稿的「通用设置」之后——符合「关于」惯例，改动纯追加、不扰动既有区块。

维护者待办（只做一次）：

1. GitHub 仓库 → Settings → Secrets and variables → Actions，新增：
   - `TAURI_SIGNING_PRIVATE_KEY` = 本机 `C:\Users\lenovo\.tauri\llm-status-board.key` 的**文件内容全文**
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` = 生成时设置的密码（见实施对话；请存入密码管理器）
2. 私钥文件与公钥（`.key` / `.key.pub`）保留在本机 `C:\Users\lenovo\.tauri\`，**绝不提交仓库**；私钥丢失 = 老用户无法自动更新。
3. 发版节奏：v0.2.4 是首个带 `latest.json` 的 Release（发布后在 Assets 确认有 `latest.json` 与 `.sig`）；完整更新链路最早在 v0.2.5 验证。v0.2.3 及更早版本没有更新功能，Release Notes 里提醒这些用户最后手动下载一次。

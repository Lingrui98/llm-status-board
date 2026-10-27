# Nightly 发布与更新渠道

## 更新渠道

应用提供两个更新渠道。旧配置没有 `updateChannel` 字段时，应用使用稳定版。

| 渠道 | 更新清单 | 用途 |
|---|---|---|
| 稳定版 | `https://github.com/Lingrui98/llm-status-board/releases/latest/download/latest.json` | 已正式发布的版本 |
| nightly | `https://github.com/Lingrui98/llm-status-board/releases/download/nightly/latest.json` | 最新主线构建 |

GitHub 的 `releases/latest` 不包含 prerelease。nightly 因此不会改变稳定版渠道的更新结果。

用户在「设置 → 关于与更新」选择渠道。应用保存选择并立即检查。应用只在用户点击「立即更新」后下载安装。

## 版本规则

nightly 使用以下 SemVer 格式：

```text
<tauri.conf.json 基础版本>-nightly.<UTC YYYYMMDD>.<workflow 运行编号>
```

例如：`0.2.12-nightly.20261028.25`。

Rust 更新命令按以下规则比较版本：

1. 当前版本与所选渠道相同时，只接受更高的 SemVer。
2. 当前版本与所选渠道不同时，接受不同的 SemVer。
3. 第二条允许从 nightly 切回版本号较低的稳定版。
4. 版本号完全相同时，不重复安装。

`check_channel_update` 只读取所选渠道的一个端点。它返回官方插件的 `Update` 资源。官方插件继续执行下载、签名校验和安装。

## 每日发布流程

定时配置为 `0 18 * * *`，即每天 18:00 UTC。北京时间是次日 02:00。GitHub 定时任务可能延迟。

本仓库当前主线为 `master`。`schedule` 只在仓库默认分支运行。手动触发也只接受 `master`。

工作流按以下顺序执行：

1. 读取当前主线提交。
2. 查找已发布的 `nightly` prerelease。
3. 从发布说明读取 `<!-- nightly-commit:FULL_SHA -->` 标记。
4. 如果标记等于当前提交，工作流跳过后续构建。
5. 工作流清理旧的滚动 release，并创建新 draft。
6. 工作流把 `nightly` 标签移到当前提交。
7. 工作流调用 `release.yml`，复用 Windows 和 macOS 构建矩阵。
8. 每个构建任务只修改自己 checkout 中的版本号。工作流不回写仓库文件。
9. 所有构建任务向同一个 release 上传安装包、签名和 `latest.json`。
10. 发布任务检查版本号和三个平台的签名清单。
11. 检查通过后，工作流把 draft 发布为 prerelease。

工作流使用 `concurrency` 串行执行。它不会取消已经开始的发布。

## 失败恢复

只有已发布的 nightly 参与提交比较。失败运行留下的 draft 不会阻止下次重试。

滚动 release 会在构建前重建。构建期间，nightly 更新清单可能暂时不可用。稳定版渠道不受此过程影响。

如果任一平台构建失败，发布任务不会运行。下次定时或手动运行会重新构建当前主线提交。

## 仓库配置

工作流复用以下 Actions Secrets：

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

工作流使用 `GITHUB_TOKEN` 管理 release，权限为 `contents: write`。仓库设置必须允许工作流使用此权限。

两个渠道使用同一个更新公钥。更新私钥不得提交到仓库。

## 手工验收

1. 手动触发一次 nightly 工作流，并确认三个平台资产完整。
2. 在主线没有新提交时再次触发，并确认工作流跳过构建。
3. 检查 `nightly` release 为 prerelease，并确认提交标记正确。
4. 检查 `latest.json` 包含 `windows-x86_64`、`darwin-aarch64` 和 `darwin-x86_64`。
5. 在应用中分别检查稳定版和 nightly。
6. 从稳定版安装 nightly，再切回稳定版安装。
7. 确认每次安装都通过签名校验，并在重启后显示所选版本。

# macOS 托盘浮层非激活交互修复

## 已确认的路径

- 用户确认：其他应用获焦时，浮层手柄不更新光标。点击后可拖动，结束后主窗口可能跳到前台。
- tao 0.37.1 的 `set_focus` 调用 `activateIgnoringOtherApps:YES`。不能用该接口修复后台悬停。
- tao 的 `set_visible(true)` 走 `make_key_and_order_front_sync`。配置中的 `focus:false` 不能单独保证后续 show 不获取焦点。
- WebKit 默认鼠标跟踪可能限制为 `ActiveInKeyWindow`。`acceptFirstMouse` 只解决首次点击，不保证后台悬停。

## 本次修改

- macOS summary 转为非激活 NSPanel。Windows 保留原窗口逻辑。
- 使用固定提交的 tauri-nspanel 2.1.1：`3ffa93ed14e0f8e857e43619b4157f2a685d35a4`。
- 不替换 Tao 原有窗口 delegate，不改变整个应用的激活策略。
- 显示使用面板 `orderFrontRegardless`，隐藏使用 `orderOut`。两者均在主线程执行。
- 删除 pointer-enter 中的 `set_focus`。
- 在实际 WKWebView 上增加 ActiveAlways 鼠标跟踪。保留 WebKit 自身的 tracking areas。
- 跟踪区域使用 InVisibleRect，随窗口调整尺寸。NSView 持有并管理该区域。
- 原生鼠标事件到达后，仅对可见的 NonactivatingPanel 调用 `makeKeyWindow`，不调用 `set_focus` 或 `activateIgnoringOtherApps`。
- 在手柄区域设置原生缩放光标。手柄坐标与 CSS 保持一致，并用测试约束。
- 底部使用短而柔和的阴影，避免大模态阴影被 8 像素透明边距裁切。

## 诊断纠正

`NSApplication.isActive` 不能单独用于判断前台应用是否切换。独立 NSPanel 实验中，`makeKeyWindow` 后 isActive 变为 true，但 NSWorkspace.frontmostApplication 的进程未改变。早期诊断根据 isActive 误判为前台切换，之后改用系统前台进程验证。

可用 `LSB_SUMMARY_HOVER_DIAGNOSTICS=1` 启用局部诊断。日志只记录面板状态、手柄进入和进程编号，不记录键盘输入或账号数据。默认不启用。

## 验证

- 630 项前端测试通过。
- 20 项 Rust 浮层测试通过，包含后台跟踪和手柄坐标测试。
- macOS release 构建通过。本地签名校验通过。
- 已安装到 `/Users/goulingrui/Applications/LLM Status Board Test.app`，确认进程启动。
- 旧测试版备份到 `src-tauri/target/local-test-backup/LLM Status Board Test-before-nonactivating.app`。
- 未更改正式版，未发布。
- 用户最终确认：不点击时光标会变化，拖动后主窗口没有跳到前台。阴影更自然。
- 同期诊断记录：测试版进程 35925，进入面板前后系统前台进程均为 95708，隐藏后仍为 95708。记录两轮进入及退出，未出现前台进程切换。
- 最终验证覆盖上述用户操作场景，不代表已经验证所有 macOS 版本、多屏或全屏场景。

## 手工验收

1. 保持测试版主窗口打开，再点击浏览器，使浏览器处于前台。
2. 悬停测试版托盘图标，直接移到右下角手柄。检查未点击时的光标。
3. 拖动并松手，等待至少 3 秒。检查主窗口没有跳到前台。
4. 重复放大、缩小、移出隐藏和再次进入。
5. 检查 Escape 隐藏和点击账号行打开主窗口仍正常。

## 上游参考

- https://github.com/tauri-apps/tao/blob/tao-v0.37.1/src/platform_impl/macos/util/async.rs
- https://github.com/tauri-apps/tao/blob/tao-v0.37.1/src/platform_impl/macos/window.rs
- https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/WebViewImpl.mm
- https://github.com/ahkohd/tauri-nspanel/tree/3ffa93ed14e0f8e857e43619b4157f2a685d35a4

// R18 托盘悬停「用量总结」浮层入口（summary.html）。
// 引入主设计系统 styles.css 复用同一套变量（明暗两套由 useTheme 按配置切换），
// 再叠加浮层专属布局 —— 不引 recharts，保持秒开。

import React from "react";
import ReactDOM from "react-dom/client";
import "../styles.css";
import "./summary.css";
import SummaryPopup from "./SummaryPopup";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SummaryPopup />
  </React.StrictMode>,
);

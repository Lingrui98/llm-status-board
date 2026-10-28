import { useEffect, useRef, useState } from "react";
import type { ProviderKind } from "../types";
import { PROVIDER_KINDS } from "../types";

/** 可复制条目（关键 URL / 示例值） */
export interface Copyable {
  label: string;
  value: string;
}

/** 一种提供商类型的凭证获取教程 */
export interface CredentialGuide {
  /** 一句话说明这类账号需要什么凭证 */
  need: string;
  /** 分步获取流程 */
  steps: string[];
  /** 可一键复制的关键 URL / 示例值 */
  copyables?: Copyable[];
  /** 额外提醒（轮换、币种、接口风险等） */
  note?: string;
}

/**
 * 各类型凭证获取教程。内容与 AccountForm 的 AUTH_FIELDS hint、README「凭证怎么填」保持一致，
 * 只描述现有接口与既有取法，不引入新接口。
 */
export const CREDENTIAL_GUIDES: Record<ProviderKind, CredentialGuide> = {
  oneApi: {
    need: "站点访问令牌（access_token，推荐），或 sk- 开头的 API Key —— 两者填一个即可。",
    steps: [
      "在浏览器里登录你的 one-api 系中转站网页",
      "按 F12 打开开发者工具，切到「网络 / Network」标签",
      "刷新页面，点开任意一个 API 请求，在请求头里找到 Authorization: Bearer xxx",
      "复制 Bearer 后面的那串 token，填入「访问令牌」",
      "（也可以）在「API Key（可选）」框填 sk- 开头的 Key —— 改走 /v1/dashboard/billing 计费接口",
    ],
    note: "注意是站点下发的访问令牌，不是 sk- 开头的 API Key。站点点数 → 美元的换算系数默认 500000 点 = 1 美元，可在表单里调整。",
  },
  newApi: {
    need: "访问令牌（access_token）+ 用户 ID（New-Api-User），或 sk- 开头的 API Key —— 两种方式二选一。",
    steps: [
      "在浏览器里登录你的 new-api 系中转站网页",
      "按 F12 打开开发者工具，切到「网络 / Network」标签，刷新页面",
      "点开任意一个 API 请求：请求头 Authorization: Bearer xxx —— 复制 xxx 填入「访问令牌」",
      "同一请求的请求头 New-Api-User: 1234 —— 把这串数字填入「用户 ID」",
      "（部分站点）也可以在 F12 → Application → Local Storage 里直接找到 token",
    ],
    note: "填了 sk- API Key 就无需令牌与用户 ID（走 /v1/dashboard/billing）。额度换算系数默认 500000 点 = 1 美元，可在表单里调整。",
  },
  sub2Api: {
    need: "sk- 开头的 API Key（推荐）；也可用访问令牌，或用户名/邮箱 + 密码 —— 三选一。",
    steps: [
      "登录 sub2api 站点，在「API Key / 密钥」页面创建或复制一个 sk- 开头的 Key",
      "把 Key 填入「API Key（推荐）」即可 —— 余额与用量走 /v1/usage 一次拿全",
      "没有 Key 时：改填访问令牌，或用户名/邮箱 + 密码（任选其一）",
    ],
    copyables: [{ label: "Key 示例格式", value: "sk-..." }],
  },
  modelServer: {
    need: "面板网页 localStorage 里的 refresh_token（access_token 一般留空）。推荐使用应用内网页登录自动获取。",
    steps: [
      "Base URL 填 API 后端地址 https://codeapi.cs.ac.cn（不是网页面板 code.cs.ac.cn；填错了会自动纠正）",
      "点击「使用网页登录」，在应用内窗口完成面板授权；返回面板后会自动回填 refresh_token",
      "点击「测试连接」，确认余额和订阅窗口后保存；外部浏览器无法回填凭据",
      "手动回退：登录网页面板，按 F12 → Application → Local Storage → 面板域名",
      "找到 refresh_token 条目，复制它的值并填入「refresh_token」",
    ],
    copyables: [{ label: "API 后端地址", value: "https://codeapi.cs.ac.cn" }],
    note: "refresh_token 是一次性轮换的：每次查询后应用会自动保存新 token，无需手动更新。",
  },
  aiHubMix: {
    need: "AiHubMix 的 API Key，无需访问令牌或用户 ID。",
    steps: [
      "打开 aihubmix.com 并登录，在控制台的 API Key 页面创建或复制密钥",
      "把密钥填入「API Key」；站点地址保持 https://aihubmix.com，无需添加 /v1",
      "点击「测试连接」，确认余额与累计用量后保存账号",
    ],
    copyables: [{ label: "Base URL", value: "https://aihubmix.com" }],
    note: "以美元展示总额度、累计已用额度与余额；接口用量单位为美分，应用自动换算为美元。计费接口不提供按日、按模型或 Token 明细。",
  },
  custom: {
    need: "无固定凭证要求 —— 取决于你自己配置的查询接口。",
    steps: [
      "在下方「自定义 HTTP 查询」编辑器里配置一个返回 JSON 的 HTTP 请求（方法 / URL / 请求头）",
      "用点路径标出数值字段，如 data.quota 或 balance_infos[0].total_balance",
      "URL / Header / Body 里用 {key} 占位符引用上方「API Key」框里填的 Key",
      "点「测试连接」验证提取结果，再按需调整路径与缩放系数",
    ],
    copyables: [
      { label: "Key 占位符", value: "{key}" },
      { label: "路径示例", value: "data.quota" },
    ],
  },
  deepSeek: {
    need: "DeepSeek 开放平台的 API Key（sk- 开头）。",
    steps: [
      "打开 platform.deepseek.com 并登录",
      "左侧「API keys」→「创建 API key」",
      "复制 sk- 开头的 Key 填入；Base URL 保持默认 https://api.deepseek.com",
    ],
    copyables: [
      { label: "开放平台", value: "https://platform.deepseek.com" },
      { label: "Base URL", value: "https://api.deepseek.com" },
    ],
    note: "展示充值 / 赠送余额，支持 CNY 与 USD。",
  },
  openAi: {
    need: "管理员权限的 API Key（sk-admin-... 或 sk-svcacct-...）。",
    steps: [
      "打开 platform.openai.com 并登录",
      "创建带 admin 权限的 key（普通 sk- key 无法查询组织用量）",
      "填入「API Key」—— 查询的是本月组织用量（OpenAI 不提供 key 级余额）",
    ],
    copyables: [{ label: "开放平台", value: "https://platform.openai.com" }],
    note: "访问 OpenAI 接口通常需要代理：在「设置 → 通用设置」里填写网络代理（http:// 或 socks5://）。",
  },
  openAiSubscription: {
    need: "ChatGPT Plus/Pro/团队等套餐的 Codex 登录凭据；API 平台的 sk- Key 无法查询订阅额度。",
    steps: [
      "点击「使用 ChatGPT 登录」，在此电脑的浏览器完成官方授权，再返回面板保存；无需安装 Codex",
      "登录未自动打开时，可点击「打开登录页面」或复制登录链接；面板最多等待 5 分钟，可随时取消",
      "已有 Codex 登录时，也可点击「选择 auth.json」；通常在用户目录的 .codex/auth.json，使用 CODEX_HOME 时在对应目录",
      "macOS 可在文件选择器按 Cmd+Shift+G 输入路径；Windows 可在地址栏输入 %USERPROFILE%\\.codex",
      "没有可读取的登录文件或使用系统钥匙串时，可手动填写自己的 ChatGPT Access Token；团队多工作区可填写对应的 Account ID",
      "点击测试连接，确认返回订阅窗口；之后显示已用/剩余比例及重置时间",
    ],
    copyables: [{ label: "Codex 用量页", value: "https://chatgpt.com/codex/settings/usage" }],
    note: "浏览器登录的凭据仅保存在本机，由面板自动续期；配置导出不含这组令牌，换电脑需重新登录。断开登录后保存生效。外部 auth.json 和手动令牌不自动刷新 OAuth 令牌，仍需在 Codex 更新或手动替换。查询比例不代表消息数、美元费用或 ChatGPT 网页聊天额度。",
  },
  siliconFlow: {
    need: "硅基流动的 API Key（sk- 开头）。",
    steps: [
      "打开 cloud.siliconflow.cn 并登录",
      "进入「API 密钥」页面，新建或复制密钥",
      "填入「API Key」；Base URL 保持默认 https://api.siliconflow.cn",
    ],
    copyables: [
      { label: "控制台", value: "https://cloud.siliconflow.cn" },
      { label: "Base URL", value: "https://api.siliconflow.cn" },
    ],
    note: "展示总余额 / 充值 / 赠送；币种按域名区分（.cn = CNY）。",
  },
  moonshot: {
    need: "开放平台 sk- key，或 Kimi for Coding 订阅的 sk-kimi- key —— 按前缀自动分流。",
    steps: [
      "按量计费：platform.moonshot.cn →「API Key 管理」创建 sk- key → 查开放平台余额",
      "Kimi 订阅：www.kimi.com/code/console 生成 sk-kimi- 开头的 key → 查订阅额度",
      "把 key 填入「API Key」，应用按前缀自动选择查询方式，无需额外设置",
    ],
    copyables: [
      { label: "开放平台", value: "https://platform.moonshot.cn" },
      { label: "Kimi 订阅控制台", value: "https://www.kimi.com/code/console" },
    ],
    note: "sk-kimi- 订阅模式展示 5h / 7d / 月度用量窗口、并发上限与加油包；其他 sk- 查可用 / 现金 / 代金券余额。",
  },
  zhipu: {
    need: "智谱开放平台的 API Key（格式 xxxx.xxxxxxxx）。",
    steps: [
      "打开 open.bigmodel.cn 并登录",
      "进入控制台「API Keys」页面，复制你的 key",
      "填入「API Key」；Base URL 保持默认 https://open.bigmodel.cn",
    ],
    copyables: [
      { label: "控制台", value: "https://open.bigmodel.cn" },
      { label: "Base URL", value: "https://open.bigmodel.cn" },
    ],
    note: "走控制台内部接口展示可用余额 / 累计消费（CNY）—— 非官方公开 API，接口有变动风险。",
  },
  dashScope: {
    need: "阿里云百炼的 API-KEY（sk- 开头）。",
    steps: [
      "打开阿里云百炼控制台 bailian.console.aliyun.com 并登录",
      "进入「API-KEY 管理」，创建或复制 sk- 开头的 Key",
      "填入「API Key」；Base URL 保持默认 https://dashscope.aliyuncs.com",
    ],
    copyables: [
      { label: "百炼控制台", value: "https://bailian.console.aliyun.com" },
      { label: "Base URL", value: "https://dashscope.aliyuncs.com" },
    ],
    note: "sk- key 本身没有余额查询接口（计费在阿里云主账号），卡片会显示相应说明。",
  },
};

/** 单行可复制条目：code 展示 + 复制按钮（成功短暂变「已复制」） */
function CopyRow({ label, value }: Copyable) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // 剪贴板 API 不可用（权限/旧 WebView）时退回 execCommand
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        // 实在复制不了也不报错，按钮仍给出反馈
      }
      ta.remove();
    }
    setCopied(true);
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="copy-row">
      <span className="copy-label">{label}</span>
      <code>{value}</code>
      <button
        type="button"
        className={`link-btn copy-btn${copied ? " copied" : ""}`}
        onClick={copy}
        aria-label={`复制${label}`}
      >
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

interface Props {
  /** 当前所选提供商类型 */
  kind: ProviderKind;
}

/**
 * 凭证获取帮助面板：按类型展示完整获取教程。
 * 被三处复用：AccountForm「怎么获取？」折叠区、WelcomeGuide 第 ③ 步、帮助面板。
 */
export default function CredentialHelp({ kind }: Props) {
  const guide = CREDENTIAL_GUIDES[kind];
  const meta = PROVIDER_KINDS.find((k) => k.value === kind);
  if (!guide) return null;
  return (
    <div className="cred-help">
      <div className="cred-help-head">
        <span className={`badge ${meta?.group === "官方" ? "badge-official" : "badge-relay"}`}>
          {meta?.label ?? kind}
        </span>
        <span className="muted small">需要的凭证</span>
      </div>
      <p className="cred-need">{guide.need}</p>
      <ol className="cred-steps">
        {guide.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
      {guide.copyables && guide.copyables.length > 0 && (
        <div className="copy-rows">
          {guide.copyables.map((c) => (
            <CopyRow key={c.label} label={c.label} value={c.value} />
          ))}
        </div>
      )}
      {guide.note && <p className="cred-note">{guide.note}</p>}
    </div>
  );
}

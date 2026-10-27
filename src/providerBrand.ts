import type { ProviderKind } from "./types";

export interface ProviderBrand {
  letter: string;
  tone: string;
  label: string;
}

/** 卡片左上角的品牌字母标识。颜色只负责识别，状态仍由右侧状态点表达。 */
export function providerBrand(kind: ProviderKind): ProviderBrand {
  const brands: Record<ProviderKind, ProviderBrand> = {
    deepSeek: { letter: "D", tone: "blue", label: "DeepSeek" },
    openAi: { letter: "O", tone: "green", label: "OpenAI" },
    openAiSubscription: { letter: "G", tone: "green", label: "ChatGPT" },
    siliconFlow: { letter: "S", tone: "violet", label: "SiliconFlow" },
    moonshot: { letter: "M", tone: "violet", label: "Moonshot" },
    zhipu: { letter: "Z", tone: "blue", label: "智谱" },
    dashScope: { letter: "A", tone: "orange", label: "阿里云百炼" },
    oneApi: { letter: "O", tone: "cyan", label: "one-api" },
    newApi: { letter: "N", tone: "blue", label: "new-api" },
    sub2Api: { letter: "S", tone: "pink", label: "sub2api" },
    modelServer: { letter: "M", tone: "cyan", label: "ModelServer" },
    aiHubMix: { letter: "A", tone: "violet", label: "AiHubMix" },
    custom: { letter: "C", tone: "neutral", label: "自定义查询" },
  };
  return brands[kind];
}

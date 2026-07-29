import type { CredentialService } from "../credentials/credentialService.js";
import type { OpenAIReasoningEffort } from "../providers/types.js";

export interface OpenAIModel {
  id: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: readonly OpenAIReasoningEffort[];
}

interface ModelsResponse {
  data?: Array<{ id?: unknown }>;
}

const ALL_EFFORTS: readonly OpenAIReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

interface ToolCapability {
  description: string;
  text: boolean;
  images: boolean;
  functionCalling: boolean;
  streaming: boolean;
}

export const OPENAI_TOOL_CAPABILITY_CATALOG: Readonly<
  Record<string, ToolCapability>
> = {
  "gpt-5.6-sol": {
    description: "Flagship quality for difficult coding and agentic work",
    text: true,
    images: true,
    functionCalling: true,
    streaming: true,
  },
  "gpt-5.6-terra": {
    description: "Balanced quality, latency, and API cost",
    text: true,
    images: true,
    functionCalling: true,
    streaming: true,
  },
  "gpt-5.6-luna": {
    description: "Fast, efficient model for high-volume work",
    text: true,
    images: true,
    functionCalling: true,
    streaming: true,
  },
};

export function formatOpenAIModelName(id: string): string {
  const match = /^gpt-(\d+(?:\.\d+)?)-(sol|terra|luna)$/i.exec(id);
  if (!match) {
    return id;
  }
  const version = match[1] ?? "";
  const tier = match[2] ?? "";
  return `GPT-${version} ${tier[0]?.toUpperCase() ?? ""}${tier.slice(1)}`;
}

export function isCompatibleOpenAIModelId(id: string): boolean {
  const capability = OPENAI_TOOL_CAPABILITY_CATALOG[id];
  return Boolean(
    capability?.text &&
      capability.images &&
      capability.functionCalling &&
      capability.streaming,
  );
}

export function parseOpenAIModels(response: unknown): OpenAIModel[] {
  if (typeof response !== "object" || response === null) {
    throw new Error("OpenAI returned an invalid model-list response.");
  }
  const data = (response as ModelsResponse).data;
  if (!Array.isArray(data)) {
    throw new Error("OpenAI did not return a model list.");
  }
  const ids = new Set(
    data
      .map((entry) =>
        typeof entry.id === "string" ? entry.id.trim() : "",
      )
      .filter((id) => id && isCompatibleOpenAIModelId(id)),
  );
  return [...ids]
    .sort((left, right) => right.localeCompare(left))
    .map((id) => ({
      id,
      displayName: formatOpenAIModelName(id),
      description: OPENAI_TOOL_CAPABILITY_CATALOG[id]?.description ?? "",
      supportedReasoningEfforts: ALL_EFFORTS,
    }));
}

export class OpenAIModelService {
  public constructor(private readonly credentialService: CredentialService) {}

  public async validateKey(): Promise<void> {
    await this.listModels();
  }

  public async listModels(): Promise<OpenAIModel[]> {
    const apiKey = await this.credentialService.getOpenAIApiKey();
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const message =
        response.status === 401
          ? "OpenAI rejected the API key."
          : `OpenAI model discovery failed with status ${response.status}.`;
      throw new Error(message);
    }
    return parseOpenAIModels(await response.json());
  }
}

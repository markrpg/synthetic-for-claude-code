import type { CredentialService } from "../credentials/credentialService.js";

export const SYNTHETIC_MODELS_URL =
  "https://api.synthetic.new/openai/v1/models";
export const SYNTHETIC_QUOTAS_URL =
  "https://api.synthetic.new/v2/quotas";
export const SYNTHETIC_USAGE_URL =
  "https://dev.synthetic.new/usage";

const REQUEST_TIMEOUT_MS = 10_000;

export interface SyntheticModel {
  id: string;
  source: "alias" | "api";
  aliasResolution?: string;
  category?: string;
  ownedBy?: string;
  contextLength?: number;
}

export interface SyntheticQuota {
  fiveHour?: {
    max: number;
    remaining: number;
    used: number;
    remainingPercent: number;
    nextTickAt?: string;
    tickPercent?: number;
    tickRequests?: number;
    limited?: boolean;
  };
  weekly?: {
    percentRemaining: number;
    usedPercent: number;
    nextRegenAt?: string;
    maxCredits?: number;
    remainingCredits?: number;
    nextRegenCredits?: number;
    regenPercent?: number;
  };
  legacy?: {
    limit: number;
    requests: number;
    remaining: number;
    renewsAt?: string;
  };
}

interface LegacySyntheticQuota {
  limit: number;
  requests: number;
  remaining: number;
  renewsAt?: string;
}

export type SyntheticApiErrorCode =
  | "unauthorized"
  | "network"
  | "timeout"
  | "response";

export class SyntheticApiError extends Error {
  public constructor(
    public readonly code: SyntheticApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SyntheticApiError";
  }
}

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

type CredentialReader = Pick<CredentialService, "getSyntheticToken">;

interface JsonRecord {
  [key: string]: unknown;
}

export const SYNTHETIC_ALIAS_MODELS: readonly SyntheticModel[] = [
  {
    id: "syn:large:text",
    source: "alias",
    aliasResolution: "hf:zai-org/GLM-5.2",
    category: "Large text",
  },
  {
    id: "syn:small:text",
    source: "alias",
    aliasResolution: "hf:zai-org/GLM-4.7-Flash",
    category: "Small text",
  },
  {
    id: "syn:large:vision",
    source: "alias",
    aliasResolution: "hf:moonshotai/Kimi-K2.7-Code",
    category: "Large vision",
  },
  {
    id: "syn:small:vision",
    source: "alias",
    aliasResolution: "hf:Qwen/Qwen3.6-27B",
    category: "Small vision",
  },
];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
    ? value
    : undefined;
}

function readContextLength(record: JsonRecord): number | undefined {
  for (const key of [
    "context_length",
    "context_window",
    "max_context_length",
    "max_model_len",
  ]) {
    const value = positiveNumber(record[key]);
    if (value !== undefined) {
      return value;
    }
  }

  const metadata = record.metadata;
  return isRecord(metadata) ? readContextLength(metadata) : undefined;
}

function isEmbeddingModel(record: JsonRecord, id: string): boolean {
  const modelType = [
    record.type,
    record.model_type,
    isRecord(record.metadata) ? record.metadata.type : undefined,
  ]
    .map(nonEmptyString)
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .toLowerCase();
  return (
    id.toLowerCase().includes("embed") ||
    modelType.includes("embedding")
  );
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : undefined;
}

function validDateString(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : undefined;
}

function currencyNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return nonNegativeNumber(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function parseRollingFiveHourQuota(
  value: unknown,
): SyntheticQuota["fiveHour"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const max = positiveNumber(value.max);
  const rawRemaining = nonNegativeNumber(value.remaining);
  if (max === undefined || rawRemaining === undefined) {
    return undefined;
  }
  const remaining = Math.min(max, rawRemaining);
  const rawTickPercent = nonNegativeNumber(value.tickPercent);
  const tickPercent =
    rawTickPercent === undefined
      ? undefined
      : clampPercent(
          rawTickPercent <= 1
            ? rawTickPercent * 100
            : rawTickPercent,
        );
  const nextTickAt = validDateString(value.nextTickAt);
  return {
    max,
    remaining,
    used: max - remaining,
    remainingPercent: (remaining / max) * 100,
    ...(nextTickAt ? { nextTickAt } : {}),
    ...(tickPercent !== undefined
      ? {
          tickPercent,
          tickRequests: (tickPercent / 100) * max,
        }
      : {}),
    ...(typeof value.limited === "boolean"
      ? { limited: value.limited }
      : {}),
  };
}

function parseWeeklyQuota(
  value: unknown,
): SyntheticQuota["weekly"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const rawPercentRemaining = nonNegativeNumber(
    value.percentRemaining,
  );
  if (rawPercentRemaining === undefined) {
    return undefined;
  }
  const percentRemaining = clampPercent(rawPercentRemaining);
  const maxCredits = currencyNumber(value.maxCredits);
  const remainingCredits = currencyNumber(value.remainingCredits);
  const nextRegenCredits = currencyNumber(value.nextRegenCredits);
  const nextRegenAt = validDateString(value.nextRegenAt);
  const regenPercent =
    maxCredits !== undefined &&
    maxCredits > 0 &&
    nextRegenCredits !== undefined
      ? clampPercent((nextRegenCredits / maxCredits) * 100)
      : undefined;
  return {
    percentRemaining,
    usedPercent:
      Math.round((100 - percentRemaining) * 100) / 100,
    ...(nextRegenAt ? { nextRegenAt } : {}),
    ...(maxCredits !== undefined ? { maxCredits } : {}),
    ...(remainingCredits !== undefined
      ? { remainingCredits }
      : {}),
    ...(nextRegenCredits !== undefined
      ? { nextRegenCredits }
      : {}),
    ...(regenPercent !== undefined ? { regenPercent } : {}),
  };
}

function parseLegacyQuota(value: unknown): LegacySyntheticQuota | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const limit = nonNegativeNumber(value.limit);
  const requests = nonNegativeNumber(value.requests);
  if (limit === undefined || requests === undefined) {
    return undefined;
  }
  const renewsAt = validDateString(value.renewsAt);
  return {
    limit,
    requests,
    remaining: Math.max(0, limit - requests),
    ...(renewsAt ? { renewsAt } : {}),
  };
}

export function parseModelsResponse(value: unknown): SyntheticModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new SyntheticApiError(
      "response",
      "Synthetic returned an invalid model-list response.",
    );
  }

  const models = new Map<string, SyntheticModel>();
  for (const rawModel of value.data) {
    if (!isRecord(rawModel)) {
      continue;
    }
    const id = nonEmptyString(rawModel.id);
    if (!id || isEmbeddingModel(rawModel, id)) {
      continue;
    }
    const ownedBy =
      nonEmptyString(rawModel.owned_by) ??
      nonEmptyString(rawModel.provider);
    const contextLength = readContextLength(rawModel);
    models.set(id, {
      id,
      source: "api",
      ...(ownedBy ? { ownedBy } : {}),
      ...(contextLength ? { contextLength } : {}),
    });
  }

  return [...models.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

export function mergeAliasAndApiModels(
  apiModels: readonly SyntheticModel[],
): SyntheticModel[] {
  const aliases = SYNTHETIC_ALIAS_MODELS.map((model) => ({ ...model }));
  const aliasIds = new Set(aliases.map((model) => model.id));
  return [
    ...aliases,
    ...apiModels.filter((model) => !aliasIds.has(model.id)),
  ];
}

export function parseQuotaResponse(value: unknown): SyntheticQuota {
  if (!isRecord(value)) {
    throw new SyntheticApiError(
      "response",
      "Synthetic returned an invalid quota response.",
    );
  }
  const fiveHour = parseRollingFiveHourQuota(
    value.rollingFiveHourLimit,
  );
  const weekly = parseWeeklyQuota(value.weeklyTokenLimit);
  if (fiveHour || weekly) {
    return {
      ...(fiveHour ? { fiveHour } : {}),
      ...(weekly ? { weekly } : {}),
    };
  }
  const legacy = parseLegacyQuota(value.subscription);
  if (!legacy) {
    throw new SyntheticApiError(
      "response",
      "Synthetic returned no supported quota counters.",
    );
  }
  return { legacy };
}

function formatNumber(value: number): string {
  return Number.isInteger(value)
    ? value.toString()
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatPercent(value: number): string {
  return `${formatNumber(value)}%`;
}

function formatCurrency(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatTimestamp(value: string | undefined): string {
  return value ? new Date(value).toLocaleString() : "not supplied";
}

export function formatQuotaStatus(quota: SyntheticQuota): string {
  const windows: string[] = [];
  if (quota.fiveHour) {
    windows.push(
      `5h ${formatPercent(quota.fiveHour.remainingPercent)}`,
    );
  }
  if (quota.weekly) {
    windows.push(
      `wk ${formatPercent(quota.weekly.percentRemaining)}`,
    );
  }
  if (windows.length > 0) {
    return `${windows.join(" · ")} left`;
  }
  const legacy = quota.legacy;
  return legacy
    ? `legacy ${formatNumber(legacy.remaining)}/${formatNumber(
        legacy.limit,
      )} left`
    : "unavailable";
}

export function formatQuotaDetails(quota: SyntheticQuota): string {
  const details: string[] = [];
  if (quota.fiveHour) {
    const fiveHour = quota.fiveHour;
    let detail = `Five-hour requests: ${formatNumber(
      fiveHour.remaining,
    )} of ${formatNumber(fiveHour.max)} remaining (${formatPercent(
      fiveHour.remainingPercent,
    )}).`;
    if (fiveHour.tickPercent !== undefined) {
      const tickRequests = fiveHour.tickRequests;
      detail += ` Regenerates ${formatPercent(
        fiveHour.tickPercent,
      )}${
        tickRequests === undefined
          ? ""
          : ` (${formatNumber(tickRequests)} ${
              tickRequests === 1 ? "request" : "requests"
            })`
      } at ${formatTimestamp(fiveHour.nextTickAt)}.`;
    } else if (fiveHour.nextTickAt) {
      detail += ` Next regeneration: ${formatTimestamp(
        fiveHour.nextTickAt,
      )}.`;
    }
    if (fiveHour.limited) {
      detail += " Requests are currently limited.";
    }
    details.push(detail);
  }
  if (quota.weekly) {
    const weekly = quota.weekly;
    const creditBalance =
      weekly.remainingCredits !== undefined &&
      weekly.maxCredits !== undefined
        ? `${formatCurrency(
            weekly.remainingCredits,
          )} of ${formatCurrency(weekly.maxCredits)} remaining`
        : `${formatPercent(weekly.percentRemaining)} remaining`;
    let detail = `Weekly credits: ${creditBalance}`;
    if (
      weekly.remainingCredits !== undefined &&
      weekly.maxCredits !== undefined
    ) {
      detail += ` (${formatPercent(weekly.percentRemaining)})`;
    }
    detail += ".";
    if (weekly.nextRegenCredits !== undefined) {
      detail += ` Regenerates ${
        weekly.regenPercent === undefined
          ? ""
          : `${formatPercent(weekly.regenPercent)} `
      }(${formatCurrency(
        weekly.nextRegenCredits,
      )}) at ${formatTimestamp(weekly.nextRegenAt)}.`;
    } else if (weekly.nextRegenAt) {
      detail += ` Next regeneration: ${formatTimestamp(
        weekly.nextRegenAt,
      )}.`;
    }
    details.push(detail);
  }
  if (quota.legacy) {
    const legacy = quota.legacy;
    const remainingPercent =
      legacy.limit > 0
        ? (legacy.remaining / legacy.limit) * 100
        : 0;
    details.push(
      `Legacy subscription counter: ${formatNumber(
        legacy.remaining,
      )} of ${formatNumber(
        legacy.limit,
      )} requests remaining (${formatPercent(
        remainingPercent,
      )}). Renews: ${formatTimestamp(
        legacy.renewsAt,
      )}. Synthetic did not return rolling-limit fields.`,
    );
  }
  return details.join(" ");
}

export class SyntheticApiService {
  public constructor(
    private readonly credentialService: CredentialReader,
    private readonly fetcher: FetchLike = globalThis.fetch,
  ) {}

  public async listModels(): Promise<SyntheticModel[]> {
    const response = await this.getJson(SYNTHETIC_MODELS_URL);
    return mergeAliasAndApiModels(parseModelsResponse(response));
  }

  public async getQuota(): Promise<SyntheticQuota> {
    return parseQuotaResponse(await this.getJson(SYNTHETIC_QUOTAS_URL));
  }

  private async getJson(url: string): Promise<unknown> {
    const token = await this.credentialService.getSyntheticToken();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "GET",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: controller.signal,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || controller.signal.aborted)
      ) {
        throw new SyntheticApiError(
          "timeout",
          "Synthetic did not respond within 10 seconds.",
        );
      }
      throw new SyntheticApiError(
        "network",
        "Could not reach the Synthetic API.",
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 401 || response.status === 403) {
      throw new SyntheticApiError(
        "unauthorized",
        "Synthetic rejected the saved API token. Update it and try again.",
      );
    }
    if (!response.ok) {
      throw new SyntheticApiError(
        "response",
        `Synthetic API request failed with status ${response.status}.`,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new SyntheticApiError(
        "response",
        "Synthetic returned a non-JSON response.",
      );
    }
  }
}

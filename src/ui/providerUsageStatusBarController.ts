import * as vscode from "vscode";
import type { BridgeManager } from "../bridge/bridgeManager.js";
import type { BridgeUsageSnapshot } from "../bridge/types.js";
import type { ClaudeSettingsService } from "../configuration/claudeSettingsService.js";
import type { RedactingLogger } from "../logging/redactingLogger.js";
import type { ProviderRegistry } from "../providers/providerRegistry.js";
import type { DetectedProvider } from "../providers/types.js";
import { detectProvider } from "../validation/providerDetector.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: value >= 100_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
}

function rateLimitHeadroom(snapshot: BridgeUsageSnapshot): string {
  const rateLimits = snapshot.rateLimits;
  if (!rateLimits) {
    return "Rate-limit headroom unavailable";
  }
  const rows: string[] = [];
  if (
    rateLimits.remainingRequests !== undefined &&
    rateLimits.limitRequests !== undefined &&
    rateLimits.limitRequests > 0
  ) {
    rows.push(
      `${((rateLimits.remainingRequests / rateLimits.limitRequests) * 100).toFixed(1)}% request headroom`,
    );
  }
  if (
    rateLimits.remainingTokens !== undefined &&
    rateLimits.limitTokens !== undefined &&
    rateLimits.limitTokens > 0
  ) {
    rows.push(
      `${((rateLimits.remainingTokens / rateLimits.limitTokens) * 100).toFixed(1)}% token headroom`,
    );
  }
  return rows.length > 0 ? rows.join(" · ") : "Rate-limit headroom unavailable";
}

function codexPrimary(snapshot: BridgeUsageSnapshot): Record<string, unknown> {
  const codex = record(snapshot.codex);
  return record(record(codex.rateLimits).primary);
}

function availableResetCredit(
  snapshot: BridgeUsageSnapshot,
): { id?: string; count: number } {
  const credits = record(
    record(record(snapshot.codex).rateLimits).rateLimitResetCredits,
  );
  const count =
    typeof credits.availableCount === "number"
      ? credits.availableCount
      : 0;
  const rows = Array.isArray(credits.credits)
    ? credits.credits.map(record)
    : [];
  const first = rows.find((item) => item.status === "available");
  return {
    count,
    id: typeof first?.id === "string" ? first.id : undefined,
  };
}

function codexUsageDetail(snapshot: BridgeUsageSnapshot): string {
  const summary = record(record(snapshot.codexUsage).summary);
  const lifetime =
    typeof summary.lifetimeTokens === "number"
      ? `${formatNumber(summary.lifetimeTokens)} lifetime tokens`
      : undefined;
  const buckets = Array.isArray(
    record(snapshot.codexUsage).dailyUsageBuckets,
  )
    ? (record(snapshot.codexUsage).dailyUsageBuckets as unknown[])
        .map(record)
        .filter(
          (bucket) =>
            typeof bucket.startDate === "string" &&
            typeof bucket.tokens === "number",
        )
    : [];
  const latest = buckets.at(-1);
  const daily =
    latest &&
    typeof latest.startDate === "string" &&
    typeof latest.tokens === "number"
      ? `${formatNumber(latest.tokens)} tokens on ${latest.startDate}`
      : undefined;
  return [lifetime, daily].filter(Boolean).join(" · ");
}

export class ProviderUsageStatusBarController
  implements vscode.Disposable
{
  private readonly statusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    99,
  );
  private timer: NodeJS.Timeout | undefined;
  private refreshPromise: Promise<BridgeUsageSnapshot | undefined> | undefined;

  public constructor(
    private readonly settingsService: ClaudeSettingsService,
    private readonly providerRegistry: ProviderRegistry,
    private readonly bridgeManager: BridgeManager,
    private readonly logger: RedactingLogger,
  ) {
    this.statusItem.command = "modelHop.showUsage";
  }

  public start(): void {
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, 60_000);
  }

  public async showDetails(): Promise<void> {
    const provider = this.currentProvider();
    if (provider !== "openai-api" && provider !== "openai-codex") {
      return;
    }
    const usage = await this.refresh(true);
    if (!usage) {
      await vscode.window.showWarningMessage(
        "ModelHop usage is currently unavailable.",
      );
      return;
    }
    if (provider === "openai-api") {
      const tokens = usage.tokens;
      const detail = tokens
        ? `Requests: ${formatNumber(tokens.requestCount)} · Input: ${formatNumber(tokens.inputTokens)} · Output: ${formatNumber(tokens.outputTokens)} · Cached input: ${formatNumber(tokens.cachedInputTokens)} · Estimated API cost: ${tokens.estimatedCostUsd === undefined ? "unavailable for configured model" : `$${tokens.estimatedCostUsd.toFixed(4)}`} · ${rateLimitHeadroom(usage)}`
        : "No OpenAI API requests have been recorded in this bridge session.";
      const action = await vscode.window.showInformationMessage(
        detail,
        "Open OpenAI Usage",
        "Refresh",
      );
      if (action === "Open OpenAI Usage") {
        await vscode.env.openExternal(
          vscode.Uri.parse("https://platform.openai.com/usage"),
        );
      } else if (action === "Refresh") {
        await this.refresh(true);
      }
      return;
    }

    const primary = codexPrimary(usage);
    const used =
      typeof primary.usedPercent === "number"
        ? primary.usedPercent
        : undefined;
    const resetsAt =
      typeof primary.resetsAt === "number"
        ? new Date(primary.resetsAt * 1000).toLocaleString()
        : "unknown";
    const secondary = record(
      record(record(usage.codex).rateLimits).secondary,
    );
    const secondaryUsed =
      typeof secondary.usedPercent === "number"
        ? secondary.usedPercent
        : undefined;
    const secondaryReset =
      typeof secondary.resetsAt === "number"
        ? new Date(secondary.resetsAt * 1000).toLocaleString()
        : undefined;
    const accountUsage = codexUsageDetail(usage);
    const resetCredit = availableResetCredit(usage);
    const actions = [
      "Refresh",
      ...(resetCredit.count > 0 ? ["Use Available Reset"] : []),
    ];
    const selected = await vscode.window.showInformationMessage(
      `ChatGPT/Codex usage: primary ${used === undefined ? "unavailable" : `${used.toFixed(1)}% used`} · resets ${resetsAt}${secondaryUsed === undefined ? "" : ` · secondary ${secondaryUsed.toFixed(1)}% used${secondaryReset ? ` · resets ${secondaryReset}` : ""}`}${accountUsage ? ` · ${accountUsage}` : ""} · ${resetCredit.count} reset credit${resetCredit.count === 1 ? "" : "s"} available.`,
      ...actions,
    );
    if (selected === "Use Available Reset") {
      const confirmed = await vscode.window.showWarningMessage(
        "Consume one earned ChatGPT/Codex rate-limit reset credit now?",
        { modal: true },
        "Use Reset Credit",
      );
      if (confirmed === "Use Reset Credit") {
        await this.bridgeManager.consumeCodexReset(resetCredit.id);
        await this.refresh(true);
      }
    } else if (selected === "Refresh") {
      await this.refresh(true);
    }
  }

  public handleConfigurationChange(): void {
    void this.refresh();
  }

  public async refresh(
    force = false,
  ): Promise<BridgeUsageSnapshot | undefined> {
    if (this.refreshPromise && !force) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.doRefresh().finally(() => {
      this.refreshPromise = undefined;
    });
    return this.refreshPromise;
  }

  public dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.statusItem.dispose();
  }

  private currentProvider(): DetectedProvider {
    return detectProvider(
      this.settingsService.read().effectiveRawValue,
      this.providerRegistry.getSyntheticSettings().baseUrl,
      this.bridgeManager.getBaseUrl(),
    );
  }

  private async doRefresh(): Promise<BridgeUsageSnapshot | undefined> {
    const provider = this.currentProvider();
    if (provider !== "openai-api" && provider !== "openai-codex") {
      this.statusItem.hide();
      return undefined;
    }
    this.statusItem.show();
    try {
      const usage = await this.bridgeManager.usage();
      if (provider === "openai-api") {
        const requests = usage.tokens?.requestCount ?? 0;
        const tokens =
          (usage.tokens?.inputTokens ?? 0) +
          (usage.tokens?.outputTokens ?? 0);
        this.statusItem.text = `$(graph) OpenAI: ${formatNumber(tokens)} tok · ${requests} req`;
        this.statusItem.tooltip =
          "OpenAI API usage recorded by this local ModelHop bridge session. Click for details.";
      } else {
        const primary = codexPrimary(usage);
        const used =
          typeof primary.usedPercent === "number"
            ? primary.usedPercent
            : undefined;
        this.statusItem.text =
          used === undefined
            ? "$(graph) Codex usage"
            : `$(graph) Codex: ${Math.max(0, 100 - used).toFixed(1)}% left`;
        this.statusItem.tooltip =
          "Live ChatGPT/Codex allowance. Click for reset time and available reset credits.";
      }
      return usage;
    } catch (error) {
      this.statusItem.text = "$(warning) ModelHop usage unavailable";
      this.statusItem.tooltip =
        "Usage could not be refreshed. Click to retry.";
      this.logger.error(error);
      return undefined;
    }
  }
}

import { normaliseEnvironmentVariables } from "../configuration/mergeEnvironmentVariables.js";
import type { DetectedProvider } from "../providers/types.js";
import { DEFAULT_SYNTHETIC_SETTINGS } from "../providers/syntheticProvider.js";

export function normaliseProviderUrl(value: string): string | undefined {
  try {
    return new URL(value).toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function detectProvider(
  variables: unknown,
  syntheticBaseUrl = DEFAULT_SYNTHETIC_SETTINGS.baseUrl,
): DetectedProvider {
  const normalised = normaliseEnvironmentVariables(variables);
  if (
    normalised.containerWasMalformed ||
    normalised.malformedEntries.length > 0
  ) {
    return "invalid";
  }

  const map = new Map(
    normalised.variables.map((variable) => [
      variable.name,
      variable.value,
    ]),
  );
  const rawBaseUrl = map.get("ANTHROPIC_BASE_URL");
  if (!rawBaseUrl) {
    return "anthropic";
  }

  const normalisedUrl = normaliseProviderUrl(rawBaseUrl);
  if (!normalisedUrl) {
    return "invalid";
  }

  const syntheticUrl = normaliseProviderUrl(syntheticBaseUrl);
  return normalisedUrl === syntheticUrl ? "synthetic" : "custom";
}

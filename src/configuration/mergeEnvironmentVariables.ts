import { MANAGED_KEYS, SHARED_KEYS } from "./managedKeys.js";
import type { EnvironmentVariable } from "../providers/types.js";

export interface NormalisedEnvironment {
  variables: EnvironmentVariable[];
  malformedEntries: unknown[];
  containerWasMalformed: boolean;
}

export function isEnvironmentVariable(
  value: unknown,
): value is EnvironmentVariable {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.value === "string"
  );
}

export function normaliseEnvironmentVariables(
  value: unknown,
): NormalisedEnvironment {
  if (value === undefined) {
    return {
      variables: [],
      malformedEntries: [],
      containerWasMalformed: false,
    };
  }

  if (!Array.isArray(value)) {
    return {
      variables: [],
      malformedEntries: [value],
      containerWasMalformed: true,
    };
  }

  const variables: EnvironmentVariable[] = [];
  const malformedEntries: unknown[] = [];

  for (const entry of value) {
    if (isEnvironmentVariable(entry)) {
      variables.push({ name: entry.name, value: entry.value });
    } else {
      malformedEntries.push(entry);
    }
  }

  return { variables, malformedEntries, containerWasMalformed: false };
}

export function mergeEnvironmentVariables(
  existing: readonly unknown[] | undefined,
  replacement: readonly EnvironmentVariable[],
): EnvironmentVariable[] {
  const preserved = normaliseEnvironmentVariables(existing).variables.filter(
    (variable) => !MANAGED_KEYS.has(variable.name),
  );
  const deduplicatedReplacement = new Map<string, EnvironmentVariable>();

  for (const variable of replacement) {
    if (isEnvironmentVariable(variable)) {
      deduplicatedReplacement.set(variable.name, {
        name: variable.name,
        value: variable.value,
      });
    }
  }

  return [...preserved, ...deduplicatedReplacement.values()];
}

export function preserveExistingSharedVariables(
  existing: readonly EnvironmentVariable[],
  replacement: readonly EnvironmentVariable[],
): EnvironmentVariable[] {
  const existingShared = new Map(
    existing
      .filter((variable) => SHARED_KEYS.has(variable.name))
      .map((variable) => [variable.name, variable] as const),
  );

  return replacement.map((variable) => {
    if (!SHARED_KEYS.has(variable.name)) {
      return variable;
    }
    return existingShared.get(variable.name) ?? variable;
  });
}

export function findDuplicateManagedKeys(
  variables: readonly EnvironmentVariable[],
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const variable of variables) {
    if (!MANAGED_KEYS.has(variable.name)) {
      continue;
    }
    if (seen.has(variable.name)) {
      duplicates.add(variable.name);
    }
    seen.add(variable.name);
  }

  return [...duplicates].sort();
}

export function environmentVariablesEqual(
  left: readonly EnvironmentVariable[],
  right: readonly EnvironmentVariable[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every(
    (variable, index) =>
      variable.name === right[index]?.name &&
      variable.value === right[index]?.value,
  );
}

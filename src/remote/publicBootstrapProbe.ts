import { RemoteSetupCancelledError } from "./cancellation.js";

export interface PublicBootstrapProbeResponse {
  status: number;
  body: string;
}

export interface PublicBootstrapExpectation {
  version: string;
  sessionId: string;
  hostPublicKey: string;
  now: () => number;
}

export interface PublicBootstrapProbeOptions {
  request: () => Promise<PublicBootstrapProbeResponse>;
  isRunning: () => Promise<boolean>;
  expected: PublicBootstrapExpectation;
  attempts?: number;
  cancelled?: () => boolean;
  wait?: (completedAttempt: number) => Promise<void>;
}

export type PublicBootstrapProbeResult =
  | {
      state: "verified";
    }
  | {
      state: "connector-registered";
      lastFailure:
        | {
            kind: "transport";
          }
        | {
            kind: "transient-http";
            status: number;
          };
    };

export type PublicBootstrapProbeErrorCode =
  | "connector-stopped"
  | "unexpected-status"
  | "invalid-body"
  | "version-mismatch"
  | "session-mismatch"
  | "host-key-mismatch"
  | "expired";

export class PublicBootstrapProbeError extends Error {
  public constructor(
    public readonly code: PublicBootstrapProbeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PublicBootstrapProbeError";
  }
}

/**
 * A request implementation can throw this error for failures that retrying
 * cannot repair, such as a response that exceeds its configured size limit.
 */
export class NonRetryablePublicBootstrapRequestError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NonRetryablePublicBootstrapRequestError";
  }
}

function transientHttpStatus(
  status: number,
): boolean {
  return (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    (status >= 520 && status <= 530)
  );
}

function parseBootstrapBody(
  body: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new PublicBootstrapProbeError(
      "invalid-body",
      "The public ModelHop bootstrap response was not valid JSON.",
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new PublicBootstrapProbeError(
      "invalid-body",
      "The public ModelHop bootstrap response was not an object.",
    );
  }
  return value as Record<string, unknown>;
}

export function validateBootstrapResponse(
  response: PublicBootstrapProbeResponse,
  expected: PublicBootstrapExpectation,
  options: {
    allowExpired?: boolean;
  } = {},
): void {
  if (response.status !== 200) {
    throw new PublicBootstrapProbeError(
      "unexpected-status",
      `The ModelHop bootstrap endpoint returned HTTP ${response.status}.`,
    );
  }
  validateBootstrapBody(
    response.body,
    expected,
    options.allowExpired === true,
  );
}

function validateBootstrapBody(
  body: string,
  expected: PublicBootstrapExpectation,
  allowExpired: boolean,
): void {
  const value = parseBootstrapBody(body);
  if (value.version !== expected.version) {
    throw new PublicBootstrapProbeError(
      "version-mismatch",
      "The public endpoint reported a different ModelHop protocol version.",
    );
  }
  if (value.sessionId !== expected.sessionId) {
    throw new PublicBootstrapProbeError(
      "session-mismatch",
      "The public endpoint reported a different ModelHop session.",
    );
  }
  if (value.hostPublicKey !== expected.hostPublicKey) {
    throw new PublicBootstrapProbeError(
      "host-key-mismatch",
      "The public endpoint reported a different ModelHop host identity.",
    );
  }
  if (
    typeof value.pairingExpiresAt !== "number" ||
    typeof value.sessionExpiresAt !== "number" ||
    value.pairingExpiresAt > value.sessionExpiresAt ||
    (!allowExpired &&
      (value.pairingExpiresAt <= expected.now() ||
        value.sessionExpiresAt <= expected.now()))
  ) {
    throw new PublicBootstrapProbeError(
      "expired",
      "The public ModelHop bootstrap response was already expired.",
    );
  }
}

function connectorStopped(): PublicBootstrapProbeError {
  return new PublicBootstrapProbeError(
    "connector-stopped",
    "The Cloudflare connector stopped before the phone link was verified.",
  );
}

export async function probePublicBootstrap(
  options: PublicBootstrapProbeOptions,
): Promise<PublicBootstrapProbeResult> {
  const attempts = options.attempts ?? 12;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError("Public bootstrap attempts must be a positive integer.");
  }

  let lastFailure:
    | Extract<
        PublicBootstrapProbeResult,
        { state: "connector-registered" }
      >["lastFailure"]
    | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.cancelled?.()) {
      throw new RemoteSetupCancelledError();
    }
    if (!(await options.isRunning())) {
      throw connectorStopped();
    }

    try {
      const response = await options.request();
      if (transientHttpStatus(response.status)) {
        lastFailure = {
          kind: "transient-http",
          status: response.status,
        };
      } else {
        validateBootstrapResponse(response, options.expected);
        return { state: "verified" };
      }
    } catch (error) {
      if (
        error instanceof PublicBootstrapProbeError ||
        error instanceof NonRetryablePublicBootstrapRequestError
      ) {
        throw error;
      }
      lastFailure = { kind: "transport" };
    }

    if (attempt < attempts) {
      await options.wait?.(attempt);
    }
  }

  if (!(await options.isRunning())) {
    throw connectorStopped();
  }
  return {
    state: "connector-registered",
    lastFailure: lastFailure ?? { kind: "transport" },
  };
}

import { RemoteSetupCancelledError } from "./cancellation.js";

export interface QuickTunnelDnsResolver {
  resolve4(hostname: string): Promise<readonly string[]>;
}

export interface QuickTunnelDnsOptions {
  hostname: string;
  resolver: QuickTunnelDnsResolver;
  attempts?: number;
  maxConsecutiveErrors?: number;
  cancelled?: () => boolean;
  wait?: (completedAttempt: number) => Promise<void>;
}

export type QuickTunnelDnsReadiness =
  | { state: "published" }
  | { state: "not-published" }
  | { state: "unavailable" };

/**
 * Wait for the trycloudflare.com authoritative nameservers to publish a
 * newly-created Quick Tunnel hostname before the system resolver is allowed
 * to query it. This avoids seeding a router or recursive resolver's
 * long-lived NXDOMAIN cache during DNS propagation.
 */
export async function waitForQuickTunnelDns(
  options: QuickTunnelDnsOptions,
): Promise<QuickTunnelDnsReadiness> {
  const attempts = options.attempts ?? 6;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new RangeError(
      "Quick Tunnel DNS attempts must be a positive integer.",
    );
  }
  const maxConsecutiveErrors =
    options.maxConsecutiveErrors ?? 3;
  if (
    !Number.isSafeInteger(maxConsecutiveErrors) ||
    maxConsecutiveErrors < 1
  ) {
    throw new RangeError(
      "Quick Tunnel DNS error limit must be a positive integer.",
    );
  }
  let consecutiveErrors = 0;
  let lastAttemptSucceeded = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.cancelled?.()) {
      throw new RemoteSetupCancelledError();
    }
    try {
      const addresses = await options.resolver.resolve4(
        options.hostname,
      );
      lastAttemptSucceeded = true;
      consecutiveErrors = 0;
      if (addresses.length > 0) {
        return { state: "published" };
      }
    } catch {
      lastAttemptSucceeded = false;
      consecutiveErrors += 1;
      if (consecutiveErrors >= maxConsecutiveErrors) {
        return { state: "unavailable" };
      }
      // A newly-created hostname can briefly return NXDOMAIN. Retrying the
      // dedicated resolver does not poison the user's normal DNS cache.
    }
    if (attempt < attempts) {
      await options.wait?.(attempt);
    }
  }
  return {
    state: lastAttemptSucceeded
      ? "not-published"
      : "unavailable",
  };
}

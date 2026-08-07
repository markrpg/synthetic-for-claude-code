export function requiresRemoteControlToken(
  pathname: string,
): boolean {
  return (
    pathname === "/health" ||
    pathname.startsWith("/control/")
  );
}

export const REMOTE_CONNECT_BODY_LIMIT = 8 * 1024;
export const REMOTE_COMMAND_BODY_LIMIT = 20 * 1024 * 1024;

export function requiresLaunchTokenBeforeBody(
  pathname: string,
): boolean {
  return pathname === "/api/connect";
}

export function requiresOpenRemoteSession(
  pathname: string,
): boolean {
  return !requiresRemoteControlToken(pathname);
}

/**
 * A stopped session keeps only its encrypted event stream and terminal
 * acknowledgement command available during the short tunnel shutdown grace
 * period. Every other public route remains closed.
 */
export function allowsTerminalRemoteSession(
  pathname: string,
): boolean {
  return pathname === "/api/events" || pathname === "/api/command";
}

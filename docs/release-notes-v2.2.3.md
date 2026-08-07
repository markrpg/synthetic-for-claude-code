# ModelHop for Claude Code 2.2.3

## Continue Claude Code on your phone

This update makes Experimental phone continuation account-free. Run
**ModelHop: Continue on Phone**, scan the temporary Cloudflare Quick Tunnel
QR code, and confirm the matching six-digit pairing code. It no longer needs
GitHub or Microsoft tunnel authentication, the Cursor/VS Code CLI, or a
remote companion extension.

The Mac remains the execution host. The phone receives a touch-first
ModelHop interface for prompts, streaming, steering, cancellation, retries,
tool questions and permission activity, provider/model controls, usage,
attachments, workspace file/symbol search, text/image previews, git status,
and diffs.

No ModelHop account or hosted ModelHop relay is involved. After one-time
confirmation, ModelHop downloads official `cloudflared` 2026.7.3 into
extension storage, verifies the pinned SHA-256 digest, and disables
auto-updates. Each session gets a new public `trycloudflare.com` hostname.

## Continuity

ModelHop forks the selected workspace transcript for remote ownership, keeps
the original branch read-only, and preserves its history, provider, model,
reasoning, permission mode, and project settings. Desktop transcript changes
pause phone input to prevent divergent tool histories.

**ModelHop: Return to Laptop** closes phone input, synchronizes ModelHop
settings, stops the tunnel, and opens the continued conversation in Claude
Code. The editor reloads only when its final provider/model environment
changed.

Anthropic uses the Mac's existing Claude authentication. Synthetic, OpenAI
API, and ChatGPT/Codex continue through ModelHop's local bridge and do not
consume Anthropic allowance.

## Security model

- The controller and inference bridge remain bound to loopback.
- Browser-to-Mac messages use P-256 ECDH, HKDF-SHA-256, and AES-256-GCM in
  addition to the secret launch link. Connection and sequence metadata are
  authenticated, and duplicate command IDs share one in-flight execution.
- Pairing is confirmed on the Mac using a matching six-digit code.
- The Mac host identity and paired-device-store key use SecretStorage. The
  phone private key is non-extractable and remains in the current Quick
  Tunnel origin's IndexedDB. A new random tunnel hostname therefore requires
  a fresh desktop-confirmed pairing.
- Reconnect journals and paired-device records are authenticated and
  encrypted locally.
- Provider and repository credentials never leave the Mac.
- Workspace reads reject traversal and escaped symlinks.
- Destructive, credential, push, release, reset-credit, and external-write
  actions remain confirmation-gated.
- Access stops after the configured inactivity period and at the absolute
  session maximum. Public phone routes seal immediately when shutdown begins,
  even while connector termination is being retried.

Quick Tunnel hostnames are public and Cloudflare terminates their HTTPS
connection. Cloudflare can observe request metadata and delivers the initial
mobile client. The encrypted envelopes reduce passive access to paired
session payloads, but this Experimental browser delivery is not intended to
resist malicious client-code modification by the tunnel operator. Use it for
short-lived personal sessions.

## Status

Phone continuation remains Experimental until Quick Tunnel interruption,
multi-window recovery, sleep behavior, and all four provider workflows have
completed wider testing. Cloudflare documents Quick Tunnels as a development
service without an SLA.

The local package is `modelhop-for-claude-code-2.2.3.vsix`. Publishing,
tagging, and GitHub release creation are separate actions.

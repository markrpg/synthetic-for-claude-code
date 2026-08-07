# Changelog

## 2.2.4

- Fixed an Anthropic usage-exhaustion deadlock during Remote deep research.
  Root API errors now provide durable foreground terminal evidence even when
  Claude omits its usual result frame, while genuinely live workflows still
  retain their independent completion barrier.
- Made late and duplicate SDK results idempotent. They can update metering but
  can no longer resurrect a completed turn through a hidden pending-result
  latch, so provider switching and hand-back do not remain falsely blocked.
- Added explicit allowance-exhausted activity with reset timing, and made the
  runtime snapshot expose every quiescence contributor instead of reporting
  `idle` while an internal result, prompt, approval, or question remains.
- Allowed Return to Laptop to atomically retire and replace a provider switch
  only while its desktop action is still unclaimed and `waiting-for-turn`.
  Once settings mutation, reload, verification, or rollback begins, the
  original transaction remains fenced and must settle first.
- Reworded the affected mobile state as **Provider unavailable · switch
  queued**, avoiding the misleading claim that Claude is still responding.
- Fixed Auto-safe approval spam during deep research. Ordinary public web
  searches, DNS-verified public fetches, canonical workspace file access, and
  a narrowly audited set of read-only workspace shell inspections now proceed
  without interrupting the phone.
- Removed unconditional approval rules for WebSearch, WebFetch, and safe
  public `curl` GET/HEAD research. Uploads, request bodies, authentication,
  redirects, proxy/network overrides, sensitive URLs, private/internal hosts,
  ambiguous shell syntax, and workspace or credential escape still fail
  closed into approval.
- Added an explicit **Allow for this session** choice for known Claude
  Agent/Task/Workflow orchestration. Child tools remain independently
  mediated, matched mandatory rules can never be remembered, and **Allow
  once** never silently broadens permission.
- Made the selected remote permission mode authoritative and durable across
  command-catalog refreshes, phone reconnects, provider changes, extension
  reloads, and daemon recovery. A rejected mode change now restores the last
  confirmed mode in the mobile UI.
- Made remote completion evidence authoritative: a workflow disappearing from
  Claude's live task list now enters settlement and cannot close the query
  until its durable terminal record arrives.
- Fixed stalled hand-backs where **Force end** joined an existing indefinite
  finish wait. Finish-to-cancel escalation now pre-empts that waiter, applies
  a bounded cancellation grace, closes the query exactly once, and journals
  explicit cancellation for every unresolved work item.
- Made Force end retryable when its first loopback request is lost before
  daemon acceptance, fenced every escalation to the exact lease and hand-back
  operation, and kept active hand-backs controllable even when the lease is in
  a paused or recovery state.
- Kept transcript stability fail-closed after explicit cancellation. Force end
  restarts the full stability observation window and reports reconciliation
  progress; it never accepts a moving transcript or opens Claude twice.
- Unified phone and laptop returns around one durable daemon transaction with
  deterministic command/action IDs, terminal action receipts, reload claim
  recovery, exact fork-session reconstruction, and idempotent cleanup.
- Kept the phone connected when exact-session open or cleanup is uncertain,
  and made lost command responses display **Checking Mac** while retrying the
  same command identity instead of duplicating the action.
- Added a single-writer device fence and operation barrier. Other paired
  phones remain useful read-only monitors, while stale devices and concurrent
  provider/model changes cannot mutate or overwrite an active hand-back.
- Added live, model-aware **Thinking** and **Effort** controls to ModelHop
  Remote. Effort choices come from the active model's authoritative catalog,
  non-`none` effort enables Thinking atomically, and unsupported choices fail
  clearly instead of being silently substituted.
- Added session-only Experimental **Claude Workflows** and **Ultra** controls.
  Workflows use the existing phone approval path, forward subagent output,
  default to a small workflow guideline, and keep provider switching and
  hand-back blocked until background child work finishes. Ultra is offered
  only when Thinking, Workflows, and `xhigh` are all supported; Codex-native
  child-agent orchestration remains isolated and disabled.
- Pinned every detached Claude SDK query to the intended provider model,
  adopted the model reported by the initialized runtime, and made known
  cross-provider mismatches fail closed instead of showing an Anthropic label
  over a surviving Kimi or GPT route.
- Stopped transcript metadata, synthetic image-coordinate annotations, and
  tool-result frames from appearing as user chat messages. Adjacent assistant
  frames now consolidate by SDK message identity, and only the authoritative
  SDK result ends a remote turn.
- Made directory pagination revision-bound and completeness-checked. Repeated
  cursors, duplicate paths, live directory mutation, changing totals, and
  incomplete listings now fail explicitly; protected, unavailable, and
  unsupported entries are reported separately.
- Raised remote previews to 5 MB for text and 25 MB for supported images,
  added additional browser image formats, and added a large-text performance
  view that avoids creating thousands of mobile line controls.
- Added full-screen source and image viewing plus an isolated HTML preview.
  External resources and forms are removed, connections are blocked, and
  scripts remain disabled until the user explicitly enables interactions for
  a trusted file.
- Made explicit and conservative bare workspace references in chat open
  directly in the full-screen viewer without waiting for the complete file
  hierarchy. Incomplete unique file references are resolved on the Mac while
  ambiguous references fail with a clear error.
- Applied `xhigh` reasoning and explicit reasoning disablement to the running
  SDK rather than only changing the displayed setting.
- Preserved queued provider-switch and hand-back state across phone
  reconnects, blocking new input until the operation commits or rolls back.
  Cancelling a turn no longer freezes its timer or marks it complete before
  the SDK sends its terminal result.
- Added safe, locally bundled Markdown rendering for remote conversation,
  activity, approval, and question content, with workspace file and image
  links that open directly in the mobile Files preview.
- Corrected the constellation **More +N** control so its label is centred and
  it remains attached to its card instead of following viewport scrolling.
- Changed remote lifetime policy so a never-paired link expires after 10
  minutes, completed conversations remain available for 60 minutes by
  default, and the idle window can be set to 15 minutes, 30 minutes, 60
  minutes, 8 hours, or manual hand-back.
- Phone disconnects and browser backgrounding no longer affect active model
  turns. At the fixed eight-hour limit ModelHop blocks new work, preserves
  approvals and explicit cancellation, lets the current turn finish, and then
  performs a finish-only exact-session hand-back.
- Prevented the long local reliability gate from being interrupted by macOS
  maintenance sleep, including when the gate begins during a dark wake.

## 2.2.4

- Fixed a healthy Cloudflare Quick Tunnel being terminated after 60 seconds
  when the editor's first public-hostname lookup received and repeatedly
  reused a router-cached `NXDOMAIN` response.
- Waits for cloudflared's registered-connection event, validates the exact
  ModelHop bootstrap locally, and polls the `trycloudflare.com` authoritative
  nameservers before allowing the system resolver to query a newly-created
  hostname.
- Keeps a registered, locally verified tunnel available when only the
  editor's external self-check is unavailable. Public responses with a wrong
  protocol, session, host identity, expiry, or non-transient HTTP status still
  fail closed.
- Makes slow DNS publication cancellable, refreshes the short-lived pairing
  window only after local identity validation and again before showing the QR,
  persists connector ownership before network readiness, and verifies failed
  startup termination before forgetting a detached process.
- Added regression coverage for connector registration, delayed DNS,
  transient gateway responses, transport failures, identity mismatches, and
  connector shutdown.

## 2.2.3

- Replaced native Cursor/VS Code Dev Tunnels with account-free Cloudflare
  Quick Tunnels for **ModelHop: Continue on Phone**. GitHub/Microsoft tunnel
  login, editor CLI discovery, and the remote companion extension are no
  longer required.
- Added a managed official `cloudflared` 2026.7.3 runtime for macOS, Linux,
  and Windows x64. ModelHop downloads it only after confirmation, enforces a
  bounded download, verifies the pinned SHA-256 digest, installs atomically,
  and disables runtime auto-updates.
- Isolated Quick Tunnel startup from existing user Cloudflare configuration,
  strictly accepts only generated `https://*.trycloudflare.com` origins, and
  preserves the loopback-only server, secret launch link, encrypted pairing,
  replay protection, inactivity shutdown, and fail-closed behavior.
- Added strict Quick Tunnel URL parsing, pinned runtime-catalog checks,
  process-ownership/lifecycle tests, and explicit documentation of
  Cloudflare's public-hostname and development-service security boundary.
- Waits for the public link to reach the exact local session before showing
  its QR, refreshes expired pairing windows, reconciles orphaned tunnel
  processes, and rejects unauthenticated or oversized public request bodies
  before buffering them.
- Preserves the one-session launch capability in per-tab browser storage so
  phone reloads and tab eviction can reconnect to the same active link,
  clearing it on rejection or hand-back.
- Authenticates encrypted envelope connection/sequence metadata, coalesces
  duplicate in-flight command IDs, and seals every public phone route as
  soon as stop, hand-back, or timeout begins—even if connector termination
  needs a retry.

## 2.2.2

- Fixed the remote controller's bundled Claude SDK failing because its ESM
  runtime metadata was lost in a CommonJS build.
- Added automatic replacement of stale remote-controller builds and cleanup
  of incomplete sessions that do not have a tunnel URL.
- Added explicit multi-root support. **All workspace folders** searches
  conversations across every root, grants Claude access to each folder, and
  namespaces secondary-root files in the mobile file browser.

## 2.2.1

- Fixed **ModelHop: Continue on Phone** failing in Cursor when its
  Experimental acknowledgement could not be written to global User Settings.
  First-run consent now uses extension global storage and does not mutate the
  user's settings file.

## 2.2.0

- Added Experimental **ModelHop: Continue on Phone**, **Return to Laptop**,
  **Stop Remote Access**, and **Manage Paired Devices** commands.
- Initially added native Cursor/VS Code Dev Tunnel discovery, device sign-in,
  QR handoff, and a workspace companion. Version 2.2.3 replaces this transport
  with account-free Cloudflare Quick Tunnels.
- Added a detached loopback-only remote controller that forks the active
  Claude Code transcript, preserves workspace/provider/model/reasoning
  context, survives editor reloads, detects desktop divergence, and opens the
  continued conversation on hand-back.
- Added a touch-first encrypted mobile interface for prompts, streaming,
  steering, cancellation, retries, status/thinking, tools, questions, permission
  approvals, provider/model controls, usage and reset credits, attachments,
  workspace file and symbol search, text/image previews, selected-line
  references, git status, and diffs.
- Added application-level P-256 ECDH pairing, HKDF-SHA-256 key derivation,
  AES-256-GCM envelopes, independently verified short authentication codes,
  replay rejection, encrypted journals, encrypted paired-device storage, and
  SecretStorage-backed host identity.
- Added automatic inactivity and maximum-session shutdown, one-controller
  coordination across editor windows, duplicate action protection, companion
  integrity verification, path canonicalization, symlink/traversal rejection,
  and preview/upload limits.
- Added explicit private user-owned tunnel and local-network guidance when
  native tunnels are unavailable. ModelHop never silently opens a LAN port or
  falls back to Anthropic.
- Added remote crypto, persistence, transcript discovery, path-boundary, and
  extension command tests.

## 2.1.0

- Added automatic provider-aware context management for Synthetic, OpenAI API, and Experimental ChatGPT/Codex routes without forcing a new Claude Code conversation.
- Routed Synthetic through the loopback bridge while keeping its API token in SecretStorage and preserving live quota reporting.
- Added exact Synthetic token counting and live model context discovery where the provider reports them, Codex app-server context-window discovery, and conservative fallback budgeting.
- Added encrypted, hash-bound context summaries that preserve recent messages and keep tool calls, parallel calls, and linked results as indivisible transcript units.
- Added a single forced compaction recovery at safe transcript boundaries when an upstream provider reports context exhaustion; live Codex tool round-trips are never rewritten, and context-limit failures are terminal rather than treated as temporary server errors.
- Passed configured per-role reasoning effort to Codex turns and classified Codex authentication, usage, overload, policy, sandbox, and context failures as Claude-compatible errors.
- Added context, encryption, tool-boundary, Synthetic bridge, OpenAI error, and Codex context/effort tests.

## 2.0.0

- Renamed the public extension to **ModelHop for Claude Code** while keeping the existing extension ID and legacy `claudeProvider.*` settings.
- Added Anthropic, Synthetic, OpenAI API, and Experimental ChatGPT/Codex providers with separate role mappings and credential storage.
- Added a loopback-only Anthropic compatibility bridge for OpenAI Responses and Codex app-server requests.
- Added text, image, streaming, parallel-tool, cancellation, identifier, tool-result, and encrypted reasoning-continuity translation.
- Added a pinned, integrity-checked Codex runtime with isolated authentication, ephemeral threads, dynamic Claude tools, and native Codex tools disabled.
- Added canonical GPT model and reasoning pickers, direct API token/cost/headroom reporting, Codex allowance reporting, and confirmed reset-credit consumption.
- Generalized status items, provider menus, validation, snapshots, and full-window reload handling.
- Expanded automatic conversation repair to cover tool names, IDs, links, and incompatible thinking blocks across all provider transitions.
- Added mocked Responses and Codex app-server compatibility coverage. The Codex route remains Experimental pending opt-in live testing.
- Fixed Codex app-server sandbox serialization and reserved dynamic-tool names, retained early turn failures, bounded stalled requests, and forced stale detached bridges to restart after compatibility fixes.
- Added ModelHop logo and extension-icon artwork plus live Codex model-picker and allowance screenshots.
- Confirmed the Experimental Codex route through live account prompting and Claude MCP tool registration.

## 1.2.9

- Preserve Synthetic conversations when switching back to Anthropic by repairing incompatible tool-call IDs and their matching tool-result references.
- Remove non-Anthropic thinking and redacted-thinking blocks while reconnecting the conversation branch, preventing signature-validation errors.
- Audit client and server tool metadata, nested caller references, duplicate IDs, malformed inputs, and missing or orphaned results without guessing at unsafe repairs.
- Save a private backup before every atomic transcript repair.
- Run the migration silently during the normal switch, with a manual recovery command only for chats affected before this release.

## 1.2.8

- Fix stale Synthetic quota percentages by bypassing browser and intermediary caches on API requests.
- Refresh active Synthetic quota every minute by default and when Cursor regains focus.
- Make the quota status item fetch current values directly and show its last update time.

## 1.2.7

- Restore the full Cursor or VS Code window reload after provider, credential, or active model-routing changes.
- Use the editor's serialized state restoration so the current Claude Code conversation reliably reopens with the new provider configuration.
- Continue to avoid the global **Reload Webviews** command and never force a fresh conversation.
- Add a persistent **Don't ask again** checkbox to the provider-switch confirmation.

## 1.2.6

- Fixed an open Claude Code tab remaining blank after a provider switch.
- Removed the global **Reload Webviews** step, which discarded Claude Code's in-memory route to the active conversation.
- Preserve the current conversation across the extension-host restart without opening or forcing a fresh conversation.

## 1.2.5

- Refresh existing webviews after the extension host restarts so an open Claude Code panel reflects the newly selected provider and models.
- Keep the post-restart refresh non-blocking so extension activation cannot stall again.
- Show readable model names as the primary labels and move technical `hf:` or `syn:` identifiers into secondary details.
- Default new configurations to the actual Kimi K3 and GLM 4.7 Flash model IDs instead of generic routing aliases.

## 1.2.4

- Restart Cursor's extension host after provider, credential, or active model-routing changes instead of reloading the entire editor window.
- Keep the editor window and workspace open while ensuring Claude Code receives the new provider environment.

## 1.2.3

- Fixed the provider menu remaining stuck on **Activating Extensions…** after a provider-switch reload.
- Made the post-reload status notification non-blocking so commands are available immediately.

## 1.2.2

- Fixed switching back to Anthropic so Synthetic-only traffic and attribution flags are removed.
- Preserved settings-based native Anthropic API keys securely across provider switches.
- Confirmed that Claude.ai OAuth credentials remain owned by Claude Code and are not modified by the extension.
- Removed guidance that encouraged resuming conversation history after every reload.
- Added a Kimi K3 quick-start section and clearer model-routing guidance.
- Added a prominently disclosed Synthetic referral link.
- Expanded project metadata to improve discovery for Kimi K3, Claude Code, Cursor, and VS Code searches.

## 1.2.1

- Released the project publicly under the MIT License.
- Added screenshots of provider status, quota reporting, model routing, and model selection.
- Clarified that the extension configures Anthropic's Claude Code editor extension for VS Code and Cursor.
- Added links to the official Claude Code Marketplace listing and editor documentation.
- Reduced the README to the installation, usage, model, quota, security, and removal information users need.
- Audited the packaged files for personal information, local paths, credentials, and private keys.

## 1.2.0

- Renamed the extension to **Synthetic for Claude Code**.
- Preserved the existing extension ID and configuration keys for in-place upgrades.
- Updated command names, settings, output-channel labels, and the VSIX filename.
- Updated Sonnet and subagent defaults to `syn:large:vision` to match Synthetic's current Claude Code guide.
- Rechecked the endpoint, model aliases, live model discovery, and quota documentation against Synthetic's current docs.

## 1.1.1

- Fixed quota reporting to use Synthetic's rolling five-hour request limit and weekly credit limit.
- Added regeneration amounts and times to quota details.
- Labeled the older subscription counter as a legacy fallback.
- Made the Synthetic quota status item open the provider menu so Anthropic remains reachable.
- Updated the `syn:large:vision` alias mapping to `hf:moonshotai/Kimi-K2.7-Code`.

## 1.1.0

- Added live Synthetic model discovery through the documented `/models` endpoint.
- Added separate model selection for Claude default, Opus, Sonnet, Haiku, and subagent routes.
- Added alias-resolution context and pinned-model warnings.
- Added subscription quota status with automatic refresh.
- Added quota details and a link to Synthetic usage and billing.

## 1.0.1

- Added token setup to the provider picker.
- Prompt for a token automatically when Synthetic is selected without one.
- Removed the extra acknowledgement dialog from token setup.

## 1.0.0

- Added effective-provider status bar and provider picker.
- Added Synthetic and native Anthropic profiles.
- Added safe managed-key merging, validation, conflict and override detection.
- Added SecretStorage token commands and redacted logging.
- Added transactional writes, read-back verification, snapshots, rollback, restore, and full-window reload.
- Added unit and VS Code extension-host integration tests.

<p align="center">
  <img src="docs/images/modelhop-logo.png" alt="ModelHop logo" width="240">
</p>

<h1 align="center">ModelHop for Claude Code</h1>

Use Anthropic, Synthetic, OpenAI API, or your ChatGPT/Codex allowance from the Claude Code editor extension in Cursor and VS Code. ModelHop handles credentials, per-role model routing, usage, provider switching, and conversation compatibility.

> **Want Kimi K3 in Claude Code? [Create a Synthetic account](https://synthetic.new/?referral=mTRNs0GS)**
>
> This is the maintainer's referral link.

[Support ModelHop on Buy Me a Coffee](https://buymeacoffee.com/markrpg).

ModelHop targets Anthropic's graphical [Claude Code extension for VS Code and Cursor](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code). It does not configure standalone Claude Code CLI sessions.

## Providers and billing

| Provider | Account used | Usage charged to | Status |
|---|---|---|---|
| Anthropic | Claude.ai OAuth or your Anthropic API key | Anthropic/Claude | Stable |
| Synthetic | Synthetic API token | Synthetic quota | Stable |
| OpenAI API | OpenAI Platform API key | OpenAI API billing | Release candidate |
| OpenAI via ChatGPT/Codex | ChatGPT sign-in through a managed Codex runtime | ChatGPT/Codex allowance | **Experimental** |

The two OpenAI routes do not consume Claude model usage. Claude Code remains the editor UI and tool runner; ModelHop sends model requests through a loopback compatibility bridge.

## Kimi K3 in Claude Code

Synthetic exposes Kimi K3 as `hf:moonshotai/Kimi-K3`. ModelHop uses that canonical ID by default for the Default, Opus, Sonnet, and subagent roles. Model pickers lead with readable names and keep the exact API ID visible.

![Claude Code reporting that the session is using Kimi K3](docs/images/claude-code-kimi-k3-confirmation.png)

[See Synthetic's current model catalogue](https://dev.synthetic.new/docs/api/models), or [create a Synthetic account with the maintainer's referral link](https://synthetic.new/?referral=mTRNs0GS).

## Install

1. Install [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code).
2. Download `modelhop-for-claude-code-2.2.4.vsix` from the [latest release](https://github.com/markrpg/modelhop-for-claude-code/releases/latest).
3. Run **Extensions: Install from VSIX...** in Cursor or VS Code.
4. Select the VSIX and reload the editor.

The internal extension ID remains `private.claude-provider-switcher`, so v2 upgrades the existing extension. Existing `claudeProvider.*` settings still work. New settings use `modelHop.*`.

## Switch providers

Click the `Claude: ...` status item or run **ModelHop: Switch Provider**.

- **Anthropic** restores Claude Code's native authentication.
- **Synthetic** asks for a token on first use.
- **OpenAI API** validates and stores an OpenAI Platform key on first use.
- **OpenAI via ChatGPT/Codex** shows a one-time warning, installs a verified pinned Codex runtime, and opens browser sign-in.

Provider changes reload the full Cursor or VS Code window — required to refresh Claude Code's environment and reopen its current conversation. Running responses and subagents stop during reload.

The confirmation dialog includes **Don't ask again**. Re-enable it with `modelHop.confirmBeforeReload`.

## Model routing

Each non-Anthropic provider has separate mappings for Claude Code's Default, Opus, Sonnet, Haiku, and subagent roles.

OpenAI starts with:

| Claude role | Model | Reasoning |
|---|---|---|
| Default and Opus | `gpt-5.6-sol` | high |
| Sonnet and subagents | `gpt-5.6-terra` | medium |
| Haiku | `gpt-5.6-luna` | low |

The OpenAI API picker reads `/v1/models` and shows models in ModelHop's bundled Claude-tool compatibility catalogue. The Codex picker uses the signed-in account's `model/list` response, including its supported reasoning efforts. A missing configured model stops the switch and opens reconfiguration; ModelHop does not silently substitute another model.

Synthetic model routing uses the provider's live model list.

![Claude Code selecting a GPT model through ModelHop's Codex route](docs/images/codex-model-picker.png)

## Usage

The status bar changes with the active provider.

- Synthetic shows live five-hour and weekly quota, reset timing, and regeneration details. It refreshes every minute by default and when the editor regains focus.
- OpenAI API shows bridge-session input, cached input, output tokens, request count, estimated cost for catalogued models, and rate-limit headroom. The [OpenAI usage dashboard](https://platform.openai.com/usage) remains authoritative.
- ChatGPT/Codex shows subscription usage, reset time, and available reset credits. Consuming a reset credit always requires a separate confirmation.

![ModelHop showing the active Codex model and remaining allowance](docs/images/codex-status-bar.png)

![Synthetic five-hour and weekly quota in the status bar](docs/images/status-bar.png)

Synthetic does not document a manual quota-reset API. ModelHop only offers a reset action when Codex reports an available earned reset credit.

## Conversation continuity

Provider responses can contain tool IDs, tool names, result links, and thinking blocks that another provider rejects. ModelHop repairs current-workspace Claude Code transcripts automatically before a provider transition:

- invalid tool names and IDs get deterministic compatible replacements;
- tool results and nested caller links are updated with the matching ID;
- incompatible thinking and redacted-thinking blocks are removed;
- malformed or incomplete tool flows stop the switch instead of guessing;
- the original transcript is backed up in private extension storage.

This keeps the same Claude Code conversation usable after a switch. The repair runs locally and does not send transcript files anywhere.

## Automatic context management

Synthetic and both OpenAI routes pass through ModelHop's local compatibility bridge. Before each model request, the bridge estimates the complete Claude request—including system instructions, tool schemas, images, and reserved output—and compacts only when the selected model is nearing its context limit.

- Synthetic uses its token-count endpoint and live model context metadata when available.
- Codex supplies its model context window through app-server token-usage events.
- OpenAI API and providers that omit context metadata use the configurable conservative fallback.
- Completed old messages are summarized while recent history remains verbatim. Tool calls, parallel calls, and all linked results are kept as atomic units.
- Summaries are hash-bound to the exact transcript prefix, encrypted on disk, and reused on later turns without altering the Claude Code transcript.
- A provider context rejection at a safe transcript boundary triggers one more aggressive compaction attempt. A live Codex tool round-trip is never rewritten. If the request still cannot fit safely, ModelHop returns a terminal context error instead of repeatedly retrying it.

Compaction happens automatically between Claude Code requests, including after switching providers; it does not force a new chat. The summary request uses the active provider's Haiku-role model and therefore counts against that provider's quota or billing. Synthetic and both OpenAI routes do not consume Anthropic usage.

The defaults begin compaction at 72% of the model context window and retain about 32,000 recent tokens. Advanced controls are available as `modelHop.contextManagement.enabled`, `thresholdPercent`, `fallbackContextTokens`, and `retainRecentTokens`.

## Continue on your phone (Experimental)

Run **ModelHop: Continue on Phone** to continue a workspace Claude Code
conversation from a phone while the Mac remains powered on, online, and
awake.

On first use, ModelHop:

1. Finds the current workspace's recent Claude Code conversations. In a
   multi-root workspace, **All workspace folders** searches every root and
   keeps each folder available to the continued session.
2. Starts a detached, loopback-only mobile controller.
3. With one-time confirmation, downloads the official pinned
   `cloudflared` runtime into extension storage and verifies its published
   SHA-256 digest. You can instead set an existing executable with
   `modelHop.remote.cloudflaredPath`.
4. Starts an account-free Cloudflare Quick Tunnel to the loopback controller.
5. Waits for Cloudflare's authoritative DNS to publish the temporary address
   before allowing the normal system resolver to query it, then verifies the
   exact ModelHop session through the public link. This normally takes
   seconds, but the Experimental Quick Tunnel service can occasionally take
   longer.
6. Displays the temporary `https://…trycloudflare.com` phone link as a QR
   code.
7. Shows the same six-digit pairing code on the phone and Mac. Compare the
   codes, then choose **Pair** or **Reject** on the Mac; there is no code to
   enter.

There is no ModelHop account, GitHub or Microsoft tunnel login, editor CLI,
hosted ModelHop relay, router configuration, or LAN listener. Each session
gets a new public Quick Tunnel hostname; the secret launch link and ModelHop's
pairing protocol are the access boundary.

The phone link is valid only for its active remote session. After hand-back,
stop, or timeout, the phone shows that the link has ended. Refreshing that
address cannot restart the session. Run **ModelHop: Continue on Phone** again
to create a new URL and QR code.

### Remote lifetime and reconnection

- A tunnel that has never paired with a phone closes after 10 minutes.
- Locking the phone, backgrounding the browser, losing reception, or closing
  the display never cancels an active Claude turn. Work continues on the Mac
  and every event is journalled for reconnection through the same active link.
- After a turn completes, remote access remains available for 60 minutes by
  default. Set `modelHop.remote.idleTimeout` to 15 minutes, 30 minutes,
  60 minutes, 8 hours, or **Until manually stopped**.
- The eight-hour safety limit stops new phone prompts. Any turn already in
  progress may finish, including questions and approvals, before ModelHop
  performs an exact-session hand-back.
- Only an explicit **Stop**, **Cancel turn and return now**, or editor stop
  command interrupts active model work. Passive disconnects and timeouts do
  not.

The mobile app separates conversation and activity, shows readable task phases,
and keeps sent prompts visible while they are queued or streaming. It supports
stop, retry, interactive questions, permission approvals, provider/model/
reasoning controls, live usage, Codex reset credits, attachments, git status,
and diffs. The Files view provides a lazy multi-root hierarchy, constellation
navigator, accessible complete-list view, previews, and selected-line
references. Revision-bound pagination prevents a changing directory from
silently skipping or duplicating files; the visual constellation prioritises
nearby nodes and **More +N** opens every loaded item in the list.

Workspace paths in Claude's Markdown—including conservative bare filenames
and line references—open directly from chat. Text files up to 5 MB and
supported images up to 25 MB can be viewed full screen; very large text uses a
single-node performance view to keep mobile scrolling responsive. Self-contained
HTML files also have an isolated Preview mode. External resources, forms, and
connections are removed, and scripts stay off unless the user explicitly
enables interactions for a trusted file.

Direct manual file editing is excluded; Claude Code performs changes and the
phone shows reviewable diffs.

### Remote reasoning and workflows

The phone's **Settings** view exposes live **Thinking** and **Effort** controls
for the active model. ModelHop shows only the effort levels reported
by Claude Code or, for ChatGPT/Codex, the signed-in account's `model/list`
catalog. Selecting an active effort turns Thinking on in the same operation;
unsupported levels are rejected rather than replaced with a different value.
These controls do not rewrite `~/.claude/settings.json`. For OpenAI routes,
ModelHop also synchronises the chosen effort with that route's default mapping
so hand-back does not silently select a different effort.

For Synthetic and OpenAI routes, turning Claude-compatible Thinking off does
not imply that the upstream model stops its private reasoning. ModelHop never
fabricates Anthropic thinking blocks from provider-private reasoning.

**Claude Workflows** and **Ultra** are Experimental session controls. Enabling
them once per phone session explains the extra provider calls and allowance
they may use. Workflow invocations pass through the phone approval path,
subagent text is forwarded to the activity stream, and the default
workflow-size guideline is **small**. ModelHop treats background workflow tasks
as active work, so provider switching and hand-back wait for them; explicit
Cancel stops the child tasks and interrupts the turn.

Ultra is available only when the active model reports `xhigh`, Thinking is on,
and Claude Workflows are enabled. This is Claude Code's harness-level
orchestration. Codex-native child-agent orchestration remains a separate,
disabled capability until ModelHop can mediate descendant threads, approvals,
recovery, cancellation, usage, and duplicate-call protection end to end.

### Remote approvals and alerts

Remote sessions start in **Auto-safe** mode. Routine, workspace-scoped work can
continue without interruption. This includes ordinary public searches,
verified public page fetches, workspace file access, and tightly constrained
read-only shell inspection inside the active workspace. Destructive
operations, credential access, privileged commands, workspace escape, pushes,
releases, reset-credit use, external writes, private network access, and
ambiguous shell commands still require approval.

The phone always offers **Allow once** and **Deny**. For known Claude
Agent/Task/Workflow orchestration it can also offer **Allow for this session**;
the child tools remain subject to Auto-safe independently. Mandatory ask rules
cannot be remembered, and ModelHop never turns **Allow once** into a broader
permission or exposes an unrestricted bypass mode. The selected mode is kept
across reconnects, provider switches, editor reloads, and command refreshes.

When approval is required, ModelHop keeps an in-app banner and badge visible
until the request is resolved and asks the browser to vibrate where supported.
Choose **Enable approval alerts** in the phone's Settings view to request browser
notifications. The notification title is `ModelHop needs your approval` and
contains no action details. Selecting it opens the matching approval sheet.

Approval notifications are best-effort while the Quick Tunnel page remains
open. Reliable background notifications on iPhone require an installed Home
Screen web app, as described by [WebKit's Web Push documentation](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).
Quick Tunnel hostnames change between sessions, so persistent background push
is outside this release.

Run:

- **ModelHop: Return to Laptop** to finish the active turn by default, stop new
  phone input, synchronize provider/model settings, validate the transcript,
  and open that exact session in Claude Code. Immediate cancellation is a
  separate, explicit choice;
- **ModelHop: Stop Remote Access** to stop the local session and Cloudflare
  Quick Tunnel without opening the continuation;
- **ModelHop: Manage Paired Devices** to review or revoke pairings for the
  current temporary link. A new Quick Tunnel hostname starts with a fresh
  pairing list;
- **ModelHop: Recover Last Remote Conversation** to retry an exact-session
  reopen after an extension-host or full-window reload.

A hand-back reloads the full editor window only when the final Claude
environment differs from the one active when remote control began. The
detached model turn survives extension-host and editor reloads. ModelHop keeps
the phone route and durable recovery record until Claude opens the exact
session. If reopening fails, remote access remains available and the laptop
offers **Retry**; ModelHop does not fall back to opening the last or a blank
conversation.

### Remote security

- The mobile server and inference bridge bind only to `127.0.0.1`.
- `cloudflared` makes an outbound connection and is launched with an isolated
  ModelHop-owned configuration and auto-updates disabled. ModelHop never reads
  or modifies the user's Cloudflare configuration.
- Browser-to-Mac content is application-level encrypted with ephemeral P-256
  ECDH, HKDF-SHA-256, and AES-256-GCM. Pairing requires the same
  desktop-confirmed six-digit code. Envelope connection/sequence metadata is
  authenticated and duplicate command IDs cannot execute concurrently.
- The Mac host identity and paired-device-store key are protected by
  SecretStorage. The phone's non-extractable P-256 private key stays in that
  browser origin's IndexedDB. Because every Quick Tunnel gets a new hostname,
  a fresh tunnel requires a fresh desktop-confirmed pairing; reconnects to the
  same active link can reuse its phone key.
- Reconnect journals and paired-device records are authenticated and
  encrypted locally.
- Provider, repository, and bridge credentials never enter the phone URL or
  encrypted mobile payload.
- Commands with destructive, credential, publishing, release, or external
  write risk still require approval. File paths are canonicalized, symlink
  escapes and traversal are rejected, and preview/upload sizes are bounded.
- A never-paired link stops after 10 minutes. Completed conversations use the
  configured idle window (60 minutes by default), while active turns survive
  phone disconnects. At the fixed eight-hour limit, ModelHop revokes new phone
  input but lets an in-flight turn finish before exact-session hand-back.
- A failed Quick Tunnel stops the remote setup. ModelHop never opens a LAN
  listener or falls back to Anthropic.

Cloudflare Quick Tunnels are a development service with a temporary, random
public hostname, no uptime guarantee, a 200 in-flight-request limit, and no
Server-Sent Events support. ModelHop uses bounded long polling rather than
SSE. Cloudflare terminates the public HTTPS connection, can observe request
metadata, and delivers the initial mobile web app. Encrypted envelopes protect
paired session payloads from passive inspection, but this Experimental web
delivery is not designed to withstand malicious client-code modification by
the tunnel operator. Use it for short-lived personal sessions and stop access
when finished. [Cloudflare Quick Tunnel details and terms](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

## Local compatibility bridge

ModelHop bundles an Anthropic-compatible server on `127.0.0.1`. Synthetic and both OpenAI routes use it for `/v1/messages` and `/v1/messages/count_tokens`, text, images, streaming, parallel tool calls, cancellation, context management, and Claude-compatible errors.

For OpenAI API, the bridge translates requests to the Responses API with `store: false`. Tool schemas use `strict: false`. Incompatible tool names and IDs are mapped deterministically. Encrypted reasoning items are retained in an encrypted local continuity store; ModelHop never fabricates Anthropic thinking signatures.

For the Experimental Codex route, ModelHop downloads official Codex `0.146.0` into extension storage and verifies the package SHA-512 digest before extraction. It uses a dedicated Codex home, ephemeral app-server threads, and Claude Code's tools through experimental `dynamicTools`. Codex shell, editing, web search, MCP, apps, plugins, skills, memories, hooks, and subagents are excluded from bridged turns.

The bridge survives full-window reloads and coordinates through a fixed loopback port. Claude Code receives a bridge-only token. OpenAI keys remain in SecretStorage and never appear in `claudeCode.environmentVariables`. If the bridge or selected model is unavailable, the request fails; it does not fall back to Anthropic.

## Credentials

- Synthetic and OpenAI API credentials are stored in VS Code SecretStorage and can be rotated or removed from ModelHop.
- Anthropic OAuth credentials stay under Claude Code's control.
- A settings-based Anthropic API key is protected while another provider is active and restored on return.
- ChatGPT/Codex sign-in and sign-out are handled by the isolated managed runtime.
- Logs redact registered credentials and never include request content.
- Unrelated Claude Code environment variables are preserved. Failed configuration writes roll back from a local snapshot.

## Experimental Codex limits

The Codex route depends on OpenAI's experimental app-server `dynamicTools` interface. This v2 candidate includes mocked multi-tool, isolation, cancellation, and reload-continuity coverage. It has also passed live account testing for model discovery, usage reporting, normal prompting, and Claude MCP tool registration. Keep this route marked Experimental until the wider multi-tool and reload-recovery matrix passes.

## Remove

Switch to Anthropic or run **ModelHop: Restore Previous Configuration** before uninstalling. Removing the extension alone does not rewrite `claudeCode.environmentVariables`.

## Development

The [full product technical specification](docs/product-technical-specification.md)
defines the provider architecture, Remote protocol, security boundaries,
failure semantics, known gaps, and release acceptance criteria.

```sh
npm install
npm run check
npm run test:integration
npm run test:mobile
npm run package
```

`npm run package` creates `modelhop-for-claude-code-2.2.4.vsix` locally. Publishing, tagging, and GitHub releases are separate actions.

To exercise the mobile interface without a Claude session, provider
credentials, a tunnel, or internet access, run:

```sh
npm run remote:fixture
```

Open `http://127.0.0.1:4177` and use the scenario selector to inspect pairing,
long conversations, streaming, approvals, provider switching, reconnects,
hand-back recovery, and multi-root files. The fixture builds into
`dist-test/remote-mobile`; production assets remain in `dist/remote`.
`npm run test:mobile` runs the deterministic Playwright viewport,
accessibility, interaction, and visual-regression suite. The VSIX verifier
rejects fixture data, test controls, Playwright assets, screenshots, source
files, and development scripts.

## License

[MIT](LICENSE). Bundled dependencies retain their own terms; see
[third-party notices](THIRD_PARTY_NOTICES.md).

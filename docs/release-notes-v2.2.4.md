# ModelHop for Claude Code 2.2.4

## Provider exhaustion and route recovery

Anthropic usage exhaustion can end a model request with a terminal API-error
frame but no ordinary SDK result. ModelHop now treats that root error as
durable failure evidence for the foreground request, while preserving any
workflow that still has independent Mac-side work to finish.

Late or duplicate result frames remain useful for usage metering but cannot
make a completed turn internally busy again. A queued provider switch can
therefore proceed after the failed turn settles. If the switch has not yet
been claimed or changed any settings, Return to Laptop may atomically retire
it and take over; an in-progress route mutation must still commit or roll back
before ownership changes.

The phone now reports **Provider unavailable · switch queued** with the
provider reset/error detail, rather than implying that Claude is still
working. Runtime diagnostics also expose pending results, prompts, approvals,
questions, and terminal provider failures so presentation and operation gates
cannot disagree silently.

## Auto-safe deep-research reliability

Auto-safe no longer pauses for every WebSearch, WebFetch, or routine
workspace inspection. Public searches, DNS-verified public fetches,
canonical workspace file operations, and a deliberately small read-only
shell subset can proceed automatically. Public `curl` requests are automatic
only when ModelHop can prove they are GET/HEAD requests without redirects,
credentials, uploads, request bodies, proxy overrides, or local file output.

The first known Claude Agent, Task, or Workflow request can now be approved
with **Allow for this session**. Its child actions remain independently
checked. Mandatory ask rules, private/internal network access, credentials,
workspace escape, destructive commands, pushes, releases, privileged work,
and unknown tools cannot acquire that remembered permission.

The phone's permission selection is now authoritative state rather than a
temporary UI value. It survives reconnects, command-catalog refreshes,
provider changes, full editor reloads, and daemon recovery; a failed change
returns the selector to its last confirmed value.

## Remote hand-back reliability update

This local build also fixes a hand-back deadlock observed after long Claude
workflows. ModelHop no longer treats an empty live-task list as proof that the
workflow's final record is durable. **Finish and Return** keeps the Mac-side
query alive while settlement is uncertain; **Cancel and Return** now
pre-empts that same wait, applies a bounded grace period, and closes exactly
once even when Claude emits no further SDK event.

Phone and laptop return actions now use the same durable daemon transaction.
Action receipts, the active fork transcript, exact-session open state, and
cleanup progress survive editor reloads. A lost local response is reconciled
as **Checking Mac** rather than repeated, and stale cleanup claims are safely
reacquired.

**Cancel and Return** is now fenced to the exact lease and hand-back operation.
If a cancellation request is lost before the Mac accepts it, a later attempt
is sent again instead of being suppressed. If cancellation arrives while the
transcript is still being reconciled, ModelHop restarts the complete stability
check; it never treats a changing transcript as safe or opens the conversation
twice.

Only one paired phone connection may mutate a remote conversation. Other
paired devices can monitor progress and inspect files, but cannot prompt,
approve, change provider/model, or end the session. Provider switching and
hand-back are mutually exclusive transactions.

## Cloudflare phone-link reliability

This patch fixes **ModelHop: Continue on Phone** reporting that a healthy
Cloudflare link was unreachable after 60 seconds.

ModelHop previously queried the generated hostname as soon as Cloudflare
printed it. A local router could cache that hostname's brief pre-registration
`NXDOMAIN` response, making every retry fail even after cloudflared had
connected successfully.

ModelHop now:

- waits for cloudflared to register the tunnel connection;
- validates the exact protocol, session, host identity, and expiry against
  the loopback-only ModelHop controller;
- polls Cloudflare's authoritative `trycloudflare.com` nameservers until they
  publish the generated hostname, without seeding a recursive DNS cache;
- verifies the public bootstrap when the editor network permits it; and
- keeps a registered, locally verified tunnel available when only the
  editor's public self-check is unavailable.

Unexpected public session data, invalid identity, expiry, hard HTTP failures,
or a stopped connector still fail closed.

The Cloudflare publication wait is cancellable. ModelHop preserves connector
ownership across an editor reload, refreshes the two-minute pairing window
after readiness, and verifies that a failed or cancelled detached connector
has actually stopped.

The local package is `modelhop-for-claude-code-2.2.4.vsix`. Publishing,
tagging, and GitHub release creation remain separate actions.

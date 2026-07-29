# ModelHop for Claude Code 2.1.0

## Automatic context management

ModelHop now manages long conversations automatically for Synthetic, OpenAI API, and Experimental ChatGPT/Codex routes. It compacts completed older history before the selected model reaches its context limit, keeps recent messages verbatim, and preserves linked tool calls and results together.

The Claude Code conversation itself is not rewritten and a new chat is not required. Encrypted summaries are stored locally and reused only when their transcript prefix still matches.

Synthetic uses provider token counting and live model context metadata where available. Codex uses the model context window reported by app-server. Other cases use a configurable conservative fallback.

If a provider still rejects a request for context exhaustion at a safe transcript boundary, ModelHop makes one more aggressive compaction attempt. It never rewrites a live Codex tool round-trip. A request that still cannot fit safely stops with a context error instead of entering a retry loop.

Summary requests use the active provider's Haiku-role model and count against that provider's quota or billing. They do not consume Anthropic usage unless Anthropic itself is the active route; Anthropic remains native and does not use bridge compaction.

## Synthetic bridge

Synthetic now uses the same loopback compatibility bridge as the OpenAI routes. The Synthetic API token stays in SecretStorage and is never copied into Claude Code settings. Live five-hour and weekly quota reporting remains available.

## Codex improvements

- Sends the configured Claude-role reasoning effort with every new Codex turn.
- Learns the selected model's context window from token-usage events.
- Maps authentication, usage-limit, overload, policy, sandbox, and context failures to useful Claude-compatible errors.

The ChatGPT/Codex route remains Experimental.

## Local build

The packaged file is `modelhop-for-claude-code-2.1.0.vsix`.

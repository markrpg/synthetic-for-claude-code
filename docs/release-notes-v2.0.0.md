# ModelHop for Claude Code 2.0.0

ModelHop adds provider switching to Anthropic's Claude Code editor extension for Cursor and VS Code. Claude Code remains the interface and tool runner while model requests can use Anthropic, Synthetic, the OpenAI API, or a ChatGPT/Codex allowance.

## What's included

- Separate credentials and Claude-role model mappings for each provider.
- Kimi K3 through Synthetic, with live model discovery and five-hour and weekly quota reporting.
- Direct OpenAI Responses API support with model discovery, reasoning controls, token counts, estimated cost, and rate-limit headroom.
- Experimental ChatGPT/Codex support through a pinned official Codex 0.146.0 runtime.
- Codex subscription usage, reset times, and confirmed reset-credit consumption.
- Automatic transcript repair when switching providers in the same Claude Code conversation.
- A loopback-only Anthropic compatibility bridge with SecretStorage-backed credentials and redacted logs.

The Codex route has passed live testing for model discovery, usage reporting, normal prompts, and Claude MCP tool registration. It remains Experimental while the broader multi-tool and reload-recovery matrix is completed.

## Install

1. Install [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code).
2. Download `modelhop-for-claude-code-2.0.0.vsix` from this release.
3. Run **Extensions: Install from VSIX...** in Cursor or VS Code.
4. Select the file and reload the editor.

Existing installations upgrade in place because the internal extension ID remains `private.claude-provider-switcher`.

## Billing

- Anthropic requests use Claude usage.
- Synthetic requests use Synthetic quota.
- OpenAI API requests use OpenAI API billing.
- ChatGPT/Codex requests use the signed-in account's Codex allowance.

OpenAI and Synthetic routes do not consume Claude model usage.

## Current limitations

- Provider changes reload the full editor window so Claude Code receives the new environment.
- Running responses and subagents stop during that reload.
- OpenAI API support is a release candidate.
- ChatGPT/Codex support is Experimental and depends on Codex app-server's experimental `dynamicTools` protocol.

See the [README](../README.md) for setup, model routing, security details, screenshots, and the Kimi K3 quick start.

If ModelHop is useful to you, [you can support its development on Buy Me a Coffee](https://buymeacoffee.com/markrpg).

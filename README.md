# Synthetic for Claude Code

Run Kimi K3 and other Synthetic models inside Anthropic's Claude Code editor extension for Cursor or VS Code. Switch providers, route each Claude role to a different model, and keep live five-hour and weekly quota visible.

> **New to Synthetic? [Create your Synthetic account →](https://synthetic.new/?referral=mTRNs0GS)**
>
> This is a referral link. You can also [download the latest VSIX](https://github.com/markrpg/synthetic-for-claude-code/releases/latest).

This project targets the graphical Claude Code editor extension. It does not install or configure standalone CLI sessions launched outside Cursor or VS Code.

## Run Kimi K3 in Claude Code

Synthetic currently lists Kimi K3 under `hf:moonshotai/Kimi-K3`. This extension uses that actual model ID by default for Claude Code's Default, Opus, Sonnet, and subagent routes, so the model is identifiable instead of appearing only as a generic `syn:` route.

Claude Code reporting that the active session is routed through Synthetic to Kimi K3:

![Claude Code reports that the active session is running on hf:moonshotai/Kimi-K3](docs/images/claude-code-kimi-k3-confirmation.png)

The model picker leads with readable names such as **Kimi K3** and **GLM 4.7 Flash**, with the exact `hf:` API identifier shown as secondary detail. Advanced users can still choose a `syn:` automatic route, which is labelled using its currently documented target model.

See Synthetic's [current model catalogue](https://dev.synthetic.new/docs/api/models) for availability.

## Preview

The status bar shows the active provider and live Synthetic quota:

![Claude Code using Synthetic with five-hour and weekly quota remaining](docs/images/status-bar.png)

## Requirements

- Install Anthropic's [Claude Code for VS Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code).
- Cursor users can follow Anthropic's [VS Code and Cursor installation guide](https://code.claude.com/docs/en/ide-integrations).
- Create an API key from your [Synthetic account](https://synthetic.new/?referral=mTRNs0GS) (referral link).

## Install

1. Download `synthetic-for-claude-code-1.2.8.vsix` from the [latest GitHub release](https://github.com/markrpg/synthetic-for-claude-code/releases/latest).
2. In Cursor, run **Extensions: Install from VSIX…** from the Command Palette.
3. Select the downloaded VSIX.
4. Reload Cursor when prompted.

The internal extension ID remains `private.claude-provider-switcher`, so this build upgrades versions 1.1.x and 1.2.0 without creating a second extension. Existing `claudeProvider.*` settings are preserved.

## Use

Click the `Claude: …` status item or run **Synthetic for Claude Code: Select Provider**.

- Choose **Synthetic** to enter or reuse an API token and apply the configured model routes.
- Choose **Anthropic** to remove Synthetic-specific overrides and restore Claude Code's native authentication.
- Choose **Configure Synthetic model routing** to assign models to Claude roles.
- Choose **View Synthetic quota and usage** for current limits and regeneration details.

Provider changes reload the full Cursor or VS Code window so Claude Code receives the new environment and restores its serialized editor state. This is slower than restarting only the extension host, but it is the reliable path for preserving and reopening the active Claude Code conversation. Active Claude requests and subagents stop during the reload.

The confirmation includes a **Don't ask again** checkbox. Selecting it disables future provider-switch confirmations globally; re-enable `claudeProvider.confirmBeforeReload` in the extension's settings at any time.

If the status item is hidden, run **Synthetic for Claude Code: Use Anthropic** or **Synthetic for Claude Code: Use Synthetic** from the Command Palette.

## Model routing

The model picker reads `GET https://api.synthetic.new/openai/v1/models`, filters out embedding models, and presents readable model names with exact API IDs in the detail text.

| Claude role | Initial model |
|---|---|
| Default, Opus, Sonnet, subagents | Kimi K3 (`hf:moonshotai/Kimi-K3`) |
| Haiku | GLM 4.7 Flash (`hf:zai-org/GLM-4.7-Flash`) |

Exact models may be rotated out by Synthetic. Optional automatic routes remain available in the picker and are labelled by their current documented model rather than by the `syn:` identifier alone.

References: Synthetic's [Claude Code guide](https://dev.synthetic.new/docs/guides/claude-code), [available models](https://dev.synthetic.new/docs/api/models), and [`/models` API](https://dev.synthetic.new/docs/openai/models).

## Quota

While Synthetic is active, the status bar shows percentages remaining for the rolling five-hour request window and weekly credits, for example `Syn: 5h 33.2% · wk 56.73% left`.

Quota data comes from `GET https://api.synthetic.new/v2/quotas`. The extension uses `rollingFiveHourLimit` and `weeklyTokenLimit` when returned. The older `subscription` counter appears only as a labelled `legacy` fallback.

Synthetic regenerates quota automatically at the times shown. The extension bypasses response caches and refreshes every minute by default, whenever Cursor regains focus after 15 seconds, and whenever you click the quota indicator. Synthetic does not currently document an API for manually resetting quota.

See Synthetic's [`/quotas` reference](https://dev.synthetic.new/docs/synthetic/quotas) or run **Synthetic for Claude Code: Open Usage and Billing**.

## Credentials and settings

- The source Synthetic token is stored in VS Code `SecretStorage`.
- Claude Code requires the active token in `claudeCode.environmentVariables`, where it may be visible in Cursor's user settings while Synthetic is active. Switching to Anthropic removes it.
- Claude.ai OAuth credentials remain in Claude Code's secure credential store and are never read, changed, or deleted by this extension.
- If native Anthropic uses `ANTHROPIC_API_KEY` in Cursor settings, the extension protects it in `SecretStorage` while Synthetic is active and restores it when switching back.
- Synthetic-only model, traffic, and attribution overrides are removed in Anthropic mode so Claude Code can use its normal authentication, usage, and account services.
- Logs and configuration summaries redact credential values. API response bodies are not logged.
- Model and quota requests send the token only to the fixed Synthetic HTTPS endpoints documented above.
- Provider writes are global. Workspace or folder overrides can still take precedence; the extension warns before continuing.
- Unrelated Claude Code environment variables are preserved. Failed changes are rolled back from an extension snapshot.

Model routes and the quota refresh interval are available under **Synthetic for Claude Code** in Cursor settings. Set `claudeProvider.synthetic.usageRefreshMinutes` to `0` to disable the timed refresh; clicking the quota indicator still fetches current values.

## Remove

Switch to Anthropic or run **Synthetic for Claude Code: Restore Previous Configuration** before uninstalling. Removing the extension alone does not rewrite `claudeCode.environmentVariables`.

## License

Released under the [MIT License](LICENSE).

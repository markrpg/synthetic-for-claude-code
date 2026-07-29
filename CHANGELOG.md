# Changelog

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

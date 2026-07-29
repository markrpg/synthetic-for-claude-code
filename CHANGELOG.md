# Changelog

## 1.2.1

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

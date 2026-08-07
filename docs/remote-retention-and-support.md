# ModelHop Remote retention and support data

ModelHop keeps Remote recovery material conservatively. Automatic cleanup is
allowed only after Claude Code has visibly opened the exact returned session
on the laptop. A timeout, a failed hand-back, missing terminal evidence, or an
unknown outcome never counts as confirmation.

## Retention policy

| Material | When it becomes eligible | Time limit | Aggregate limit |
| --- | --- | ---: | ---: |
| Phone attachments | Exact-session desktop hand-back confirmed | 7 days | 512 MiB |
| Transcript recovery backups | Exact-session desktop hand-back confirmed | 30 days | 1 GiB |
| Unconfirmed recovery material | Never automatically eligible | Indefinite | No automatic size eviction |

The byte limits apply independently. When confirmed material exceeds a limit,
ModelHop removes the oldest confirmed items first. Age is measured from desktop
confirmation, not from the start of the remote turn.

Cleanup is restricted to registered ModelHop-owned directories. Each target is
canonicalised and checked again before deletion. Roots, path escapes, symlinks,
unknown roots, damaged retention metadata, and unconfirmed entries fail closed
and remain untouched. ModelHop does not scan or delete arbitrary workspace
files.

## Privacy-safe support bundle

Run **ModelHop: Create Privacy-Safe Remote Support Bundle** from the Command
Palette. The command writes a private JSON file under ModelHop's extension
storage and can reveal it in Finder or copy its correlation ID.

The bundle uses an allow list. It contains protocol/build versions, hashed
within-bundle correlation IDs, health axes, timestamps, hashed model IDs,
journal cursors, fencing generations, operation phases, work-item kinds and
terminal-evidence states.

It excludes:

- conversation and prompt text;
- provider credentials, bridge tokens, pairing codes, and tunnel URLs;
- raw tool names, arguments, output, and logs;
- provider usage payloads;
- full paths, workspace names, filenames, transcript signatures, and device
  names;
- raw error messages.

Correlation hashes are salted per bundle. They allow events inside one report
to be related without creating a stable identifier across reports.

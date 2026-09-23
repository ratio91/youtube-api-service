# Backlog — deferred options

Ideas that were discussed and consciously postponed. Not planned work; each entry says
what would trigger picking it up. Decisions about them go into `docs/decisions.md`.

## Approve playlist suggestions from Obsidian (deferred 2026-09-23)

**Idea:** review suggestions where the summary is read. The service writes the
suggestion (`suggestedName`, `suggestConfidence`, `suggestReason`) into the note's
frontmatter; the operator sets a property such as `approve: true` (or picks another
playlist); an n8n workflow on the vault host reads the synced notes and sets
`status = approved` (or the target columns) in the video table.

**Why not now:** reviewing in the n8n table view works; this adds a second writer to the
table and depends on Syncthing timing (a note moved or edited on two devices, notes that
never re-sync). Cache hits never rewrite notes, so existing notes would need
`?export=true` to get the suggestion.

**Pick up when:** reviewing in the table turns out to be tedious, or bulk approval by
confidence is not good enough after the classifier eval.

# Managed File

This file is machine-managed by nightfoundry; re-running nightfoundry init refreshes it.

# State Layout

Runs live under .harness/, pending work under queue/, delivered runs under archives/.

# Memory

Record this project's lessons, decisions, and TODOs in this project's own files.

When something about nightfoundry itself seems wrong, append one JSON line to this repo's `archives/candidates.jsonl` (create the file if absent) and mention it in one sentence in your reply. Line shape: `{"ts": "<ISO-8601>", "source": "operator-session", "slug": "<run slug if known, else null>", "summary": "<one-paragraph description: expected vs observed, with the exact error text or state evidence>"}`. This ledger is where nightfoundry's own failure routing records candidates; a periodic sweep collects both — a note that lives only in chat scrollback is never collected.

# Spec Authoring

This repo ships the nightfoundry operator skill at .claude/skills/nightfoundry-operator/ — your session loads project skills automatically; read references/spec-authoring.md before hand-writing a spec and references/debugging.md when a run stops.

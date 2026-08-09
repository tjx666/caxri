---
name: acceptance
description: >
  Verify Caxri deliveries on the real macOS Electron desktop surface, capture
  visually inspected evidence through CDP, and publish immutable review rounds
  with the LobeHub CLI. Use when Caxri work must prove user-visible behavior,
  generate an acceptance report, respond to acceptance feedback, or re-verify a
  repair. This project-local skill is strictly limited to Caxri's macOS Electron
  desktop product surface.
---

# Caxri Acceptance

Verify the delivery as its builder. A separate human review decides whether to
accept or reject it. Treat macOS Electron desktop as the only product surface.
Use focused tests, build output, logs, or probes as supporting evidence, never as
substitutes for the real desktop path when the claim is user-visible.

## Boundaries

- Exercise Caxri in an isolated Electron instance. Never drive the developer's
  resident app or real user-data directory.
- Tell the user immediately before launching because the real desktop window can
  take macOS focus during verification.
- Use CDP and `agent-browser` for renderer interaction, DOM inspection, and
  screenshots. Use OS capture only when the criterion is specifically about
  Electron or macOS chrome that CDP cannot see.
- Read every screenshot or recording before citing it. A file existing is not
  evidence that the expected UI rendered.
- Keep focused regression tests separate from acceptance evidence. Tests prove a
  contract; the desktop round proves the delivered user experience.
- Do not call `accept` or `reject` as the builder.

## Prepare

1. Read `.agents/acceptance/PROJECT.md` for the exact build, isolated launch,
   stop, CDP, and logging commands. Fix adapter drift when observed.
2. Confirm production LobeHub authentication with the adapter command.
3. Resolve the immutable one-sentence business requirement for the whole
   acceptance.
4. Author `plan[]` before testing. Give each check a stable id tied to the owning
   GitHub issue and declare its expected behavior and required evidence.
5. Create a fresh round directory containing `result.json`, `report.md`, and
   `assets/`. Inside Go use
   `.records/go/<run-id>/acceptance/round-<n>/`; for standalone verification use
   `.records/acceptance/<timestamp>/round-<n>/`.

Read [references/report.md](references/report.md) before authoring the report and
[references/evidence.md](references/evidence.md) before capturing artifacts.

## Execute the desktop round

1. Build and launch from the adapter. Confirm the CDP target is the Caxri
   renderer, not DevTools or a stale resident build.
2. Drive the smallest real user path that proves each plan item. Follow
   [surfaces/electron.md](surfaces/electron.md).
3. Capture evidence while testing:
   - settled UI state: screenshot plus DOM snapshot when useful;
   - behavior over time: GIF or video following
     [references/recording-cdp.md](references/recording-cdp.md);
   - non-visual behavior: separate reasoning and execution text artifacts.
4. Fill `cases[]` as observations are made. Every planned check with no case must
   remain visibly unexecuted; never silently remove it.
5. Report failures honestly. Once round execution starts, a product failure,
   blocked environment, invalid screenshot, or missing evidence is part of that
   round's observed result.

## Publish immutable rounds

Follow [references/report.md](references/report.md) for the authoritative ingest
commands and result schema. Preserve the returned Acceptance id, URL, and round
index. Never overwrite a published round. If ingest partially succeeds but warns
that evidence was dropped, preserve that history and publish a corrected round.

## Repair loop

Before every follow-up, read current server state and actionable feedback using
the commands in [references/report.md](references/report.md).

- Omit user-accepted checks unless the repair can regress them.
- Address non-stale rejects and reuse their stable check ids.
- Declare `supersedes` when a check's meaning is replaced, and retain the full
  lineage in later rounds.
- Route product failures back to implementation, focused validation, review,
  commit, and push before starting the next round.
- Repair adapter, fixture, capture, or report defects as verification
  infrastructure; do not mislabel them as Caxri product bugs.

## Finish

Copy any cited Main or Runtime log excerpts into the round assets before stopping
because the isolated user-data directory is temporary. Stop only the Electron
process started for this round. Keep local reports under `.records/` and expose
only the stable production acceptance URL in the user handoff. The latest round
must show complete required-evidence coverage before the delivery can wait for
human acceptance.

## Reference map

- Electron workflow: [surfaces/electron.md](surfaces/electron.md)
- CDP commands: [references/agent-browser.md](references/agent-browser.md)
- Evidence rules: [references/evidence.md](references/evidence.md)
- Report schema: [references/report.md](references/report.md)
- Temporal capture: [references/recording-cdp.md](references/recording-cdp.md)

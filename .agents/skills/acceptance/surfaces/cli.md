# Caxri CLI surface

Use this surface for `caxri` command behavior a person decides about: what a
command prints, which exit code and error code it returns, what a mutation
changed in the selected profile. The proof is the command's own output: text,
not pixels. That is the cheapest and strongest evidence here: a stable `--json`
value is harder to fake than a screenshot, and it needs no window.

Return to the desktop surface when the criterion is actually about rendered UI.
A CLI command that only exists to set up a Renderer check is setup, not the
check.

## Build and select the profile

The CLI talks only to an authenticated, profile-scoped Server and never reads
SQLite, settings, or logs directly. Agent and CI invocations never start a Server
implicitly, so an isolated Server must already exist: start the same isolated
launch the desktop surface uses, then point the CLI at its profile.

```bash
bun run build:cli
PROFILE=$(python3 -c 'import json,sys;print(json.load(open(".records/acceptance/runtime.json"))["userDataDir"])')
ARTIFACT_DIR="$ROUND_DIR/assets"
node apps/cli/dist/caxri.cjs --profile "$PROFILE" project list --json
```

`--profile` takes an absolute path and is the same directory as the launch's
`userDataDir`; `CAXRI_USER_DATA_DIR` is its environment equivalent. Never point
it at the developer's resident profile. `apps/cli/dist/caxri.cjs` requires
Node.js 24 or newer. `--help` and `capabilities --json` are the only commands
that work without a Server.

Run inside a Caxri-managed Agent Session, the CLI presents that Session's Agent
Endpoint credential (`CAXRI_AGENT_ENDPOINT_{HOST_ID,ID,GENERATION,TOKEN}`) to
whichever Server `--profile` selects. The isolated Server rejects it and the CLI
reports `UNAVAILABLE: Caxri Server is unavailable`, which reads like a Server
still starting. Prefix every call against an isolated profile with
`env -u CAXRI_AGENT_ENDPOINT_HOST_ID -u CAXRI_AGENT_ENDPOINT_ID
-u CAXRI_AGENT_ENDPOINT_GENERATION -u CAXRI_AGENT_ENDPOINT_TOKEN` so it runs as
the profile's owner.

Every mutation additionally requires `--yes`, and should carry a stable
`--request-id <id>` so a retry is safe. See [docs/cli.md](../../../../docs/cli.md)
for the full command surface.

## Prove the planned path

1. Run the smallest command sequence that reaches the planned outcome. Prefer
   `--json` so the proof is assertable, not prose.
2. Redirect stdout to `$ARTIFACT_DIR` and read it before citing it. A file
   existing is not evidence that the command produced the expected value.
3. For a mutation, capture the read-back that shows the new state, not only the
   command that requested it.

```bash
node apps/cli/dist/caxri.cjs --profile "$PROFILE" settings patch \
  --set editor.unfoldOnClick=true --yes --request-id "$CASE_ID-patch" --json \
  > "$ARTIFACT_DIR/$CASE_ID-patch.json"
node apps/cli/dist/caxri.cjs --profile "$PROFILE" settings get --json \
  > "$ARTIFACT_DIR/$CASE_ID-readback.json"
```

Cite both files in `cases[].evidence` with a `description` that names what each
one demonstrates. Declare `requiredEvidence: ["text"]` for a stdout artifact;
`markdown` only when the artifact is genuinely a reviewer-facing document.

A `cli` case still runs against an isolated profile, so its plan keeps
`stateIsolation` and its `assets/<case-id>-state-isolation.json` receipt exactly
as a desktop case does.

## Boundaries

- **Don't open a browser or a window for a CLI criterion.** If the outcome is
  satisfied by output, a screenshot adds noise, not proof.
- **Make the assertion legible.** Cite the specific value that proves the
  criterion, or name it in the `description`, not a 10k-line log the reviewer
  must scan.
- **Never upload secrets.** Pairing links, QR payloads, delegation credentials,
  tokens, Agent transcripts, Session names, and Project paths stay out of the
  artifact; strip them before writing the file.
- **A streaming command needs a stop condition.** `logs follow` and
  `events watch` run until Ctrl+C; name the observable end marker in the plan
  before running one, and keep keepalive noise (stderr) out of the artifact.
- **The `caxri` CLI is not the `lh` CLI.** `lh` publishes the round; `caxri` is
  the product under test.

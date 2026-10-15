---
id_prefix: sec
verify: true
skip_when: lockfile or generated-output-only change
calibration_exempt: true
---

# Security and Privacy

Treat Caxri as a local authority boundary around source code, shells, credentials, and agent state.
This dimension is exempt from codebase calibration.

## Quick checklist

- BrowserWindow weakens sandboxing, context isolation, CSP, navigation blocking, or new-window
  denial; external HTTP(S) links bypass explicit user confirmation
- Preload exposes `ipcRenderer`, Electron objects, environment values, or generic filesystem/process
  access
- File, search, save, Git, or repository operations accept an untrusted root/path without resolved
  Project containment, symlink-escape defense, type/size bounds, and the operation-specific race
  protection
- Save truncates before opening a validated inode with no-follow protection
- Folder-picker grants are reusable, long-lived, or survive cancellation
- PTY/Git/CLI launches concatenate shell strings, accept unvalidated argv, or inherit credential and
  Caxri-internal environment variables
- The Host's profile lock, private Unix socket, authentication handshake, or generation-bound
  Desktop lease weakens principal/capability checks or admits a second concurrent Desktop authority
- Project or Session deletion can remove the Project folder or user files
- Logs, diagnostics, fixtures, errors, or tests expose source content, terminal output/snapshots,
  shell input, prompts, agent transcripts, credentials, environment values, or presigned URL query
  strings
- Tracked files, branch or commit names, PR or issue metadata, Actions output, screenshots, traces,
  packages, or Release assets cross an `oss-confidentiality` red line
- Agent integration parses transcripts or writes provider-owned state instead of reading bounded,
  capability-detected metadata
- Capacity/output/time limits are removed from an attacker- or repository-controlled path
- Transport connectivity or an authenticated caller identity is treated as activation authority or
  mutation capability without independently validating the current principal, generation, and
  operation-specific grant

## How to check

1. Trace each new external value from the Renderer, filesystem, Git repository, CLI, config file,
   or Agent metadata to every sink.
2. Read the actual containment and environment-filter helpers; names alone are not evidence.
3. Inspect both success and error logging, including object serialization and diagnostic export.
4. For subprocesses, confirm executable and argv are structured and the target is allowlisted or
   revalidated against Runtime-owned state.
5. Separate four proofs at each privileged boundary: transport connectivity, caller principal,
   activation authority, and operation-specific mutation capability. Show when credentials become
   usable and how generation or ownership changes revoke them before the sink runs.

## Rule sources

- `AGENTS.md` architecture guardrails
- `.agents/skills/project-architecture/references/security.md`
- `.agents/skills/project-architecture/references/diagnostics.md`
- `.agents/skills/project-architecture/references/files-and-paths.md` for filesystem authority
- `.agents/skills/project-architecture/references/agent-messaging.md` for Endpoint authority
- `.agents/skills/debug/SKILL.md`
- `.agents/skills/oss-confidentiality/SKILL.md` for public-content red lines and safe patterns

## Not violations

- Synthetic, non-secret fixtures that cannot resolve to a real user path or token
- Metadata fields explicitly permitted by the diagnostics contract after redaction

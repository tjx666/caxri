# Agent-native observability and diagnostics

- Status: accepted (target; implementation pending)
- Date: 2026-08-25
- Implementation plan: [Server architecture refactor plan](../server-refactor-plan.md)

Caxri treats observability as a machine-readable product contract across Client, Server Core, Terminal
Host, Extension Host, and provider processes. Logs and traces carry stable build, Server, boot, Client,
connection, trace, request, operation, worker, Project, Session, Terminal, and Agent Run identities;
high-cardinality identities never become metric dimensions. Failures expose stable codes, reasons,
retryability, and remediation instead of requiring an Agent to infer state from prose logs.

Liveness, readiness, `caxri doctor --json`, `caxri capabilities --json`, a redacted changefeed tail, and
bounded lifecycle and crash capsules remain available independently of the normal UI path. Doctor reads
the artifact and private manifests and probes the Terminal Host even when the Server Core is unavailable.
Diagnostics never contain source contents, Draft bodies, Terminal output or snapshots, prompts,
transcripts, credentials, environment values, or secret-like settings. Local deployments never enable
an exporter. A platform operator may explicitly configure authenticated, bounded export; export failure
cannot block Server work or weaken the same content boundary.

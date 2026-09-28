---
kind: adr
status: accepted
---

# Agent-native observability and diagnostics

- Date: 2026-08-30
- Note: internal foundation implemented; public operator surfaces pending
- Implementation plan: [Server architecture refactor plan](../server-refactor-plan.md)

Caxri treats observability as a machine-readable product contract across Server Core, Terminal Host,
Extension Host, Clients, and future provider processes. The internal foundation has five deliberately
separate layers:

1. Structured logs propagate normalized build, Server, boot, connection, trace, request, operation,
   process, Project, Session, Terminal, and Agent Run correlation across asynchronous work and private
   process protocols.
2. Fixed-name metrics use only owner, phase, and outcome dimensions. Per-request samples and dynamic
   labels are unrepresentable.
3. Each Server process publishes its own private, atomic manifest under
   `<userData>/observability/processes/`. A manifest contains lifecycle state, normalized correlation,
   bounded metric aggregates, and at most one content-free failure capsule.
4. The refactor parity tooling combines those manifests with six content-free probe states to classify
   exactly one root owner: control, Server Core, Terminal Host, Extension Host, persistence, or stream.
   Classification is read-only; remediation is output data, never an automatic restart or repair.
5. The Desktop Renderer measures one named UI scenario at a time using browser observers, frame
   timestamps, and stable React Profiler boundaries. It sends only the bounded finished aggregate to
   authenticated Main IPC, which persists `renderer.performance_scenario` as flat structured-log
   fields. Component-level fiber trees are outside the diagnostic contract because their timings are
   not additive and their metadata does not meet the fixed-label privacy boundary.

## Bounds and failure isolation

- an in-memory registry retains at most 256 metric series; a process manifest retains at most 64;
- a process manifest is at most 32 KiB, is written atomically, and is restricted to the owning user
  (`0700` directory, `0600` file);
- a causal chain retains at most 128 fixed-schema capsules and manifests retain only the current capsule;
- process memory and file-descriptor sampling runs at a low fixed frequency, never overlaps, and uses
  unreferenced timers;
- logging, sampling, and publication failures are best-effort and cannot fail a command, recovery,
  shutdown, or product process;
- there is no local or remote exporter in the implemented foundation.
- Renderer scenarios retain at most 20,001 frame timestamps, 10,000 React Profiler samples, 100 fixed
  request samples, 2,000 Long Animation Frames, and 2,000 interactions, and automatically finish after
  two minutes.

Runtime validation occurs again immediately before manifest persistence. This keeps TypeScript escape
hatches or malformed internal input from writing unknown fields, dynamic metric labels, or unnormalized
failure context.

## Privacy contract

Diagnostics never contain source contents, Draft bodies, Terminal input, output or snapshots, prompts,
Agent transcripts, credentials, environment values, or secret-like settings. Correlation accepts only
bounded opaque identities. Metrics contain fixed labels and numeric aggregates only. The read-only
classifier consumes fixed probe states and never reads product payloads.
Renderer performance receipts additionally reject DOM text, paths, source locations, props, state, and
arbitrary action, surface, request, or component labels.

## Deferred public surfaces

Liveness, readiness, `caxri doctor --json`, `caxri capabilities --json`, redacted changefeed inspection,
and authenticated platform export remain later product capabilities. They must consume the same private
foundation and preserve its bounds and exclusions, but this decision does not make them part of the A6
product surface. Export failure must never block Server work or weaken the privacy boundary.

# Architecture debt audit dimensions

Use this as a complete sweep, not a menu. Tailor depth to the requested scope, but record a result for every dimension in a repository-wide audit.

| Dimension                                | Questions to answer                                                                                                                                                                                                                                                                                             | Strong evidence                                                                                                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product and contract alignment           | Does runtime behavior match `DESIGN.md`, `AGENTS.md`, architecture references, UI promises, and explicit exclusions? Are product constraints being mistaken for missing features?                                                                                                                               | A concrete behavior-to-contract comparison and the current consumer path                                                                                                                      |
| Process and capability ownership         | Does Main, Preload, Renderer, or Runtime own each operation and source of truth? Does any bridge broaden authority or bypass the structured request contract?                                                                                                                                                   | Imports, IPC schemas, dispatch tables, process startup, and event routing                                                                                                                     |
| Domain boundaries and directory taxonomy | Can an Agent predict where a new model, query, provider, panel, test, or migration belongs? Do generic names such as `state`, `store`, `utils`, or `manager` mix unrelated meanings?                                                                                                                            | Several files with conflicting ownership, repeated placement mistakes, or documentation needed to disambiguate a non-obvious boundary                                                         |
| Extension and composition points         | Can a new Agent provider, Inspector panel, command, theme importer, Git operation, or IPC method be added through one obvious path? Are adapters real interfaces or only naming conventions?                                                                                                                    | Count the independent edit sites and verify the registry, factory, exhaustive switch, dependency injection, and fallback behavior                                                             |
| Simplification and speculative surface   | Does production code have no production consumer, only test or documentation consumers, a second representation of the same fact, or a generic API with only one concrete need? Does hand-written infrastructure duplicate a dependency or Node builtin available at the engine floor?                          | Classify every consumer as production/non-production/ambiguous, trace both representations to their owner, name the next credible consumer, and compare net deletion against replacement glue |
| State, cache, and data flow              | Is each state item local UI state, cached Runtime data, or durable state? Are query keys, invalidation, Session identity, cancellation, and stale responses correct?                                                                                                                                            | Mutation-to-invalidation traces, event consumers, Session-switch behavior, and race scenarios                                                                                                 |
| Persistence and migrations               | Is the schema declarative and discoverable? Are migrations generated, packaged, ordered, atomic, and compatible with recovery? Are multiple version numbers semantically distinct or drifting?                                                                                                                  | Schema, migration loader, connection/bootstrap code, transactions, upgrade tests, and packaged behavior                                                                                       |
| Lifecycle, concurrency, and recovery     | What happens during start, attach, detach, close, delete, restart, crash, shutdown, and concurrent requests? Are ownership and cancellation revalidated after awaits?                                                                                                                                           | Timeline analysis, in-flight registries, disposal paths, bounded retries, and regression tests around interleavings                                                                           |
| Security and privacy                     | Are path grants, symlink races, argv, environments, external links, diagnostics, and Renderer capabilities bounded? Does deletion remove metadata only? Is every deserializer of user-picked file content (theme, settings, future importers) size-bounded before parsing and schema-validated after?           | Trust-boundary validation, filesystem open semantics, environment filters, redaction tests, and exact capability surfaces                                                                     |
| Performance and resources                | Is expensive native work coalesced and bounded? Are polling, snapshots, subprocesses, watchers, models, buffers, listeners, and timers disposed?                                                                                                                                                                | Measurements, benchmarks, queue/cap constants, concurrency limits, and before/after resource counts; distinguish risk from a confirmed leak                                                   |
| UI and interaction architecture          | Are panels, commands, tabs, focus, accessibility, and semantic theme tokens composed consistently? Does the UI expose implementation concepts or conflict with established interaction precedents? Does a Renderer render failure have a contained recovery path (error boundary), or does it blank the window? | The real interaction path, shared registries/reducers, focused Electron coverage, and computed behavior rather than screenshots alone                                                         |
| Toolchain and ecosystem fit              | Are dependency choices current, compatible, and intentionally pinned? Are package-manager, TypeScript, native ABI, build, and packaging boundaries understandable to Agents?                                                                                                                                    | Current official documentation, manifests, lockfile state, ADRs, build/package probes, and explicit escape plans for accepted beta risk                                                       |
| Tests, observability, and AI operability | Can a change be validated with a focused command? Do CI and local gates agree? Can logs identify the failing build and boundary without exposing content? Do instructions prevent common Agent mistakes?                                                                                                        | Project scripts, workflow gates, focused tests, structured logs, diagnostics, and exact repository instructions                                                                               |

## Evidence tests for structural debt

A structural concern becomes an actionable finding when at least one of these is true:

- one feature requires coordinated edits in unrelated owners without an exhaustive registry or compiler check;
- two directories or abstractions claim the same concept with different semantics;
- one module is both a transport, domain owner, persistence layer, and UI policy source;
- state survives or crosses a Project/Session/process boundary without that identity in its key;
- an async lifecycle resumes after its durable owner was closed or deleted;
- resource work grows with historical interaction rather than current visible state;
- a documented invariant has no implementation enforcement or behavior-level regression;
- a framework or toolchain exception repeatedly surprises Agents and lacks a local guardrail.

For simplification candidates, search the exact symbol, wire name, config key,
and both method-call forms with `rg`, then inspect every result. A candidate is
strong only when it removes a real production surface or duplicate source of
truth. Reject it when a production consumer exists, an architecture decision
owns the seam, the proposed generic API has no second credible consumer, or a
dependency swap merely relocates the same behavior and tests into wrapper glue.

The following are not debt by themselves:

- a project-specific directory that differs from a framework default;
- a synchronous API at a documented SQLite or strict-startup boundary;
- one implementation without a speculative abstraction;
- a beta dependency whose risk is accepted in an ADR and covered by real build/package gates;
- an `unknown` capability state where providers are intentionally capability-detected;
- an explicit narrow-editor or disk-wins product choice.

## Caxri-specific cross-checks

- Verify the current `Project` and `Session` ownership model before reasoning about paths or state.
- Verify Renderer code remains free of Node.js, Electron, Git, PTY, and filesystem authority.
- Verify Main-only grants and dialogs do not leak into general Runtime operations.
- Verify Runtime-owned native resources have one composition root and one disposal path.
- Verify shared IPC schemas remain the source of truth for method owner, params, results, events, and errors.
- Verify Session deletion and Project deletion never remove user files.
- Verify diagnostics exclude source, terminal output, snapshots, Agent transcripts, credentials, and secret-like values.
- Verify every parser of user-supplied file content applies a size cap before parsing, matching the convention in `files/documents.ts`.
- Verify the Renderer has a render-failure recovery path distinct from process-crash recovery; `render-process-gone` never covers a JS exception thrown during React render.
- Verify focused tests cover behavior at the process boundary; a green unit suite alone does not prove Electron or native behavior.

## Historical-session rule

Past Caxri reviews are especially useful for generating lifecycle, watcher, editor-state, directory-taxonomy, extension-point, and toolchain hypotheses. Many old findings were later fixed. Search selectively, record the commit/context of the old claim, and classify it as current, changed, resolved, or unverifiable before reporting it.

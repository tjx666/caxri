# Deep Review Harness Replay

Historical replays test whether a prompt or schema change detects a known failure mechanism without
continuing to accuse the fixed implementation. They use one context-isolated reviewer and one
independent verifier for the same bounded mechanism. Reviewer and verifier payloads must pass the
current `validate-output.ts` contract.

## 2026-08-21: cross-boundary proof obligations

Source: [PR caxri#139](https://github.com/tjx666/caxri/pull/139),
`feat: establish the Caxri Host platform`.

### Async selected-owner identity

Dimensions: `state-lifecycle`, `correctness`.

| Snapshot | Exact range                                                                          | Reviewer                                                                          | Independent verifier                                                                                                                           |
| -------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-fix  | `9deb0d1b508875581d2868e2d366224bea8b4dc5..85dca5213e2be8e47ce3340f433cfdd308ebb8b3` | `life-1`: selected Project skill health incorrectly depended on an active Session | Confirmed from the independent Project/Session selection state and Settings request path                                                       |
| Fixed    | `85dca5213e2be8e47ce3340f433cfdd308ebb8b3..9c16fe116b1bb24fe5c1c5b1c0e30648c2cee204` | No candidates                                                                     | Replayed `life-1` rejected: the reader uses `lastSelectedProjectId`, and the regression archives the only Session while retaining local health |

### Packaged Host activation authority

Dimensions: `architecture`, `security-privacy`.

| Snapshot | Exact range                                                                          | Reviewer                                                                                                 | Independent verifier                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pre-fix  | `9c16fe116b1bb24fe5c1c5b1c0e30648c2cee204..ff27ec40b3ff50b23dfe85040ff4c39cd04a60c7` | `sec-1`: Agent/CI could start an absent Host; `sec-2`: ambient absolute paths nominated the Host process | Both confirmed through `ensureHost`, operator authentication, direct `spawn`, and missing provenance checks                                                                      |
| Fixed    | `ff27ec40b3ff50b23dfe85040ff4c39cd04a60c7..b63f8f7cf6ffd7b042aa8c5c2f45b52ac464b7ba` | No same-mechanism candidates                                                                             | Replayed `sec-1` and `sec-2` rejected: automation only connects to an existing Host, launch paths derive from the exact packaged layout, and focused tests cover both boundaries |

The fixed authority review separately raised existing-Host operator-token fallback. It is not either
replayed mechanism: Caxri's documented product boundary deliberately does not claim an OS sandbox
against same-user code that can read the private owner manifest. The decision is recorded on GitHub
[issue caxri#133](https://github.com/tjx666/caxri/issues/133) and in the project architecture
reference, so it is excluded from this replay rather than misreported as a regression in the fixed
range.

All four reviewer payloads and all four verifier payloads passed the current `review` or `verify`
validator mode respectively. The replays did not edit historical refs or launch Electron.

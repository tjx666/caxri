# Verifier Prompt Template

Replace `{issues}`, `{scope_summary}`, `{review_head}`, and `{changes}`. Never use the reviewer that
produced the candidates.

````text
Independently try to falsify these Caxri review findings. Do not fix anything.

## Scope

Review head: {review_head}

{scope_summary}

## Changes

{changes}

## Candidate findings

{issues}

For every id:

1. Open the location and read the complete owning function/contract.
2. Chase relevant callers, Zod schemas, process owners, identity guards, cleanup, and focused tests.
3. Search for the counterexample first: upstream validation, a bounded queue, a current-identity
   check, framework behavior, or an existing test that prevents the scenario.
4. Validate that the scenario is introduced by this diff. For legacy code, require a concrete
   before/after trigger and use nature/exposure overrides when mislabeled.
5. Validate likelihood on a real Caxri path. Low requires an exact precondition chain.
6. Validate severity as impact, then set `blocks_release`: true for incident/security/data-loss
   impact or a broken acceptance criterion/main path; false for safely deferrable or degraded-only
   behavior. Effective P0 must block and P2 must not.
7. Apply repository calibration except for security/privacy/path/data-loss claims.
8. Require `file:line` evidence for confirmation. Unresolved external or runtime facts are
   `need_more_context`, never guessed confirmations.

Return exactly one valid JSON object in one `json` fence. Each input id appears exactly once; do not
invent ids.

- Confirmed: `id`, `verdict`, `evidence`, `blocks_release`; optional
  `severity_override`, `likelihood_override`, `nature_override`, `exposure_override`,
  `fix_options_override`, or `culprit`.
- False positive: `id`, `verdict`, `reason`.
- Need more context: `id`, `verdict`, `missing`.

The variants are strict. Confirmed items must not contain `reason`, `status`, or `severity`;
false-positive items must not contain confirmation fields; need-more-context items must not contain
either set. Put explanations in the field assigned to that verdict.

```json
{
  "verifications": [
    {
      "id": "life-1",
      "verdict": "confirmed",
      "evidence": "apps/desktop/src/renderer/src/features/editor/useDocument.ts:87 applies the reply without comparing the originating Session id, while App.tsx:211 permits switching during the request.",
      "blocks_release": true
    },
    {
      "id": "perf-2",
      "verdict": "false_positive",
      "reason": "The Runtime-wide semaphore bounds the changed call path to eight subprocesses."
    }
  ]
}
```
````

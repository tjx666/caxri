---
id_prefix: maint
verify: true
skip_when: human-facing docs or lockfile-only change
---

# Maintainability and Testing

Check whether the implementation fits Caxri's existing language, helpers, and validation workflow.

## Quick checklist

- New code reinvents an existing helper, reducer, registry, schema, semaphore, bounded queue,
  coalescer, error type, or sibling implementation
- A symptom is patched at one caller when ownership belongs in a shared layer, or a variant-specific
  quirk branches inside shared code despite an extension seam
- JavaScript/TypeScript file exceeds 800 physical lines or adds unrelated responsibilities to an
  already-large module
- New React component uses a default export, or Main/Preload/Runtime code uses Renderer-only aliases
- Non-test Node code adds synchronous APIs without a documented strict-ordering reason
- Complex lifecycle/security logic, workaround, trade-off, or external reference lacks JSDoc
  explaining why
- Dead code, pointless aliases/wrappers, copied constants, broad `any`, or a new dependency where an
  existing project dependency already solves the same need
- A bug fix lacks a focused regression; a process-boundary behavior is tested only as a pure unit;
  a component is unit-tested when extracting logic or using focused Electron E2E is clearer
- Shared Renderer/IPC changes omit `knip`, type, or focused boundary validation; native/package or
  performance changes omit their specialized gate
- Tests weaken assertions, add sleeps instead of readiness signals, or reuse a developer profile,
  path, token, transcript, or source fixture

## How to check

1. Search action-and-context terms across the repository before accepting a new utility or pattern.
2. Compare the change with the nearest same-domain source and test.
3. Map changed files to the narrowest `bun run check`, Vitest, Playwright, native, package, or
   benchmark command that observes the behavior.
4. Check the source file and its related test together; passing unrelated tests is not coverage.

## Rule sources

- `AGENTS.md` code conventions and testing workflow
- `.agents/skills/quality-check/SKILL.md`
- `.agents/skills/test/SKILL.md`
- The closest existing domain implementation

## Not violations

- Small, direct code with no reusable abstraction need
- Test-only synchronous filesystem helpers
- A focused test plan that intentionally leaves full unit/E2E suites to release or CI parity

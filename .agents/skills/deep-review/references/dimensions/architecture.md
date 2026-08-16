---
id_prefix: arch
verify: true
skip_when: human-facing docs or lockfile-only change
---

# Architecture and Reuse

Place behavior in the process and abstraction that owns the truth. Search the repository for the
nearest same-kind implementation before accepting a new route or helper.

## Quick checklist

- Renderer imports Node.js, Electron, filesystem, PTY, Git, or native APIs
- A request bypasses `packages/protocol`'s Zod params/result schemas, declared method owner
  (`host` or `desktop`), closed error taxonomy, or Preload's fixed `window.caxri` allowlist, or
  `src/shared/ipc` regrows a second method or schema table beyond compatibility re-exports
- Main takes over Host-owned Runtime/SQLite work, Runtime takes over window/dialog lifecycle,
  Renderer becomes the source of durable truth, or Desktop bypasses the generation-bound Host lease
- Project roots, repository paths, or arbitrary commands cross from Renderer instead of opaque
  Project/Session/repository identifiers and structured params
- Process Explorer's diagnostic bridge grows workbench, file, terminal, environment, or mutation
  capabilities
- New service wiring bypasses the Runtime composition root or lacks a single disposal path
- A caller-specific special case pollutes a shared layer despite an existing extension seam
- New helper, registry, reducer, catalog, or cross-layer route duplicates an established same-kind
  implementation
- An architecture or toolchain contract changes without updating the matching
  `project-architecture` reference

## How to check

1. Name the owning process before evaluating the implementation.
2. For IPC changes, trace method declaration, schema, owner, dispatcher, Preload exposure, consumer,
   error encoding, and event/reply path.
3. Search for the nearest analogous feature and compare structure and lifecycle, not names.
4. For a proposed duplicate, cite the existing implementation and show behavioral equivalence.

## Rule sources

- `.agents/skills/project-architecture/SKILL.md`
- `.agents/skills/project-architecture/references/architecture.md`
- `packages/protocol/src` and the nearest domain sibling (`src/shared/ipc` is compatibility
  re-exports only)

## Not violations

- A deliberate boundary exception already documented in architecture references
- Local duplication whose semantics or lifecycle genuinely differ
- Refactoring unrelated legacy architecture that this change neither uses nor worsens

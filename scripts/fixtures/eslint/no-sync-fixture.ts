/**
 * Fixture proving oxlint's `node/no-sync` override (`.oxlintrc.json`) actually fires inside the `scripts/**` tooling
 * scope. Excluded from the real lint gates via ignore patterns; `scripts/__tests__/oxlint-toolchain-contract.test.ts`
 * lints it with an ignore-free config copy.
 */
import { readFileSync } from 'node:fs';

export function triggerNoSync(): string {
    return readFileSync('/dev/null', 'utf8');
}

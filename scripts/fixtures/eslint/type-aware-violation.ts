/**
 * Fixture proving the type-aware linting layer (`oxlint --type-aware`, `.oxlintrc.json`) is actually wired up. Both
 * violations below compile cleanly under `tsc` (no real type error) and are only detectable with type information
 * available, so `scripts/__tests__/oxlint-toolchain-contract.test.ts` asserts the rules fire there, and
 * `scripts/__tests__/eslint-toolchain-contract.test.ts` asserts ESLint (deliberately syntactic-only) stays silent.
 *
 * This file is intentionally excluded from the `unicorn/filename-case` fixture concern (see the sibling
 * `not-kebab-case-fixture.ts`) and is not imported by any production or test module; it exists solely as ESLint's
 * target file for the contract test above.
 */

async function resolveAfterTick(): Promise<void> {
    await Promise.resolve();
}

export function triggerFloatingPromise(): void {
    resolveAfterTick();
}

export function triggerUnsafeAssignment(value: unknown): string {
    const coerced: string = value as any;
    return coerced;
}

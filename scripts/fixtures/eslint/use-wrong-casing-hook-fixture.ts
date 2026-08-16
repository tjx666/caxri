/**
 * Negative fixture proving `caxri/filename-export-mapping` fires when a `use-*.ts` hook file's primary export uses the
 * wrong casing (PascalCase instead of camelCase) for its filename mapping; see
 * `scripts/__tests__/filename-export-mapping.test.ts`. Not imported by any production or test module.
 */
export function UseWrongCasingHookFixture(): string {
    return 'use-wrong-casing-hook-fixture';
}

/**
 * Positive fixture proving `caxri/filename-export-mapping` stays silent when a `use-*.ts` hook file exports the
 * camelCase mapping of its filename; see `scripts/__tests__/eslint-toolchain-contract.test.ts`. Not imported by any
 * production or test module.
 */
export function useGoodMappedHookFixture(): string {
    return 'use-good-mapped-hook-fixture';
}

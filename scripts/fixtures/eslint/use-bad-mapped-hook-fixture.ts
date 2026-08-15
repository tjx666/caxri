/**
 * Negative fixture proving `caxri/filename-export-mapping` fires when a `use-*.ts` hook file's primary export does not
 * match the camelCase mapping of its filename; see `scripts/__tests__/eslint-toolchain-contract.test.ts`. Not imported
 * by any production or test module.
 */
export function useSomethingElse(): string {
    return 'use-bad-mapped-hook-fixture';
}

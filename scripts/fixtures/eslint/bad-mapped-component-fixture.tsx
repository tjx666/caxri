/**
 * Negative fixture proving `caxri/filename-export-mapping` fires when a component file's primary export does not match
 * the PascalCase mapping of its filename; see `scripts/__tests__/eslint-toolchain-contract.test.ts`. Not imported by
 * any production or test module.
 */
export function WrongExportName(): string {
    return 'bad-mapped-component-fixture';
}

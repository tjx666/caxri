/**
 * Positive fixture proving `caxri/filename-export-mapping` stays silent when a component file exports the PascalCase
 * mapping of its filename; see `scripts/__tests__/eslint-toolchain-contract.test.ts`. Not imported by any production or
 * test module.
 */
export function GoodMappedComponentFixture(): string {
    return 'good-mapped-component-fixture';
}

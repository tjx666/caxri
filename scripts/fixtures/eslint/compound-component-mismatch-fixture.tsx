/**
 * Negative fixture proving `caxri/filename-export-mapping` fires for a compound-component file when none of its named
 * exports match the PascalCase mapping of its filename; see `scripts/__tests__/filename-export-mapping.test.ts`. Not
 * imported by any production or test module.
 */
export function CompoundMismatch(): string {
    return 'compound-component-mismatch-fixture';
}

export function CompoundMismatchContent(): string {
    return 'compound-component-mismatch-fixture-content';
}

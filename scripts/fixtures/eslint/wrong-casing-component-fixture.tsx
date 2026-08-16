/**
 * Negative fixture proving `caxri/filename-export-mapping` fires when a component file's primary export uses the wrong
 * casing (camelCase instead of PascalCase) for its filename mapping; see
 * `scripts/__tests__/filename-export-mapping.test.ts`. Not imported by any production or test module.
 */
export function wrongCasingComponentFixture(): string {
    return 'wrong-casing-component-fixture';
}

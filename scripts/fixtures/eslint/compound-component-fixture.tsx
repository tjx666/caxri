/**
 * Positive fixture proving `caxri/filename-export-mapping` stays silent for a compound-component file when at least one
 * named export matches the PascalCase mapping of its filename, even alongside sibling sub-component exports; see
 * `scripts/__tests__/filename-export-mapping.test.ts`. Not imported by any production or test module.
 */
export function CompoundComponentFixture(): string {
    return 'compound-component-fixture';
}

export function CompoundComponentFixtureContent(): string {
    return 'compound-component-fixture-content';
}

export function CompoundComponentFixtureTrigger(): string {
    return 'compound-component-fixture-trigger';
}

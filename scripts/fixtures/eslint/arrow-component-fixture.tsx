/**
 * Positive fixture proving `caxri/filename-export-mapping` recognizes an arrow-function component export bound via
 * `export const`; see `scripts/__tests__/filename-export-mapping.test.ts`. Not imported by any production or test
 * module.
 */
export const ArrowComponentFixture = (): string => 'arrow-component-fixture';

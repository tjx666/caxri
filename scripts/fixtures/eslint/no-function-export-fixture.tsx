/**
 * Negative fixture proving `caxri/filename-export-mapping` fires with a "(no function export)" diagnosis when a
 * component file has no function-like or class named export at all; see
 * `scripts/__tests__/filename-export-mapping.test.ts`. Not imported by any production or test module.
 */
export const noFunctionExportFixtureValue = 'no-function-export-fixture';

/**
 * Positive fixture proving `caxri/filename-export-mapping` recognizes a re-exported binding (`export { Foo }`) that
 * references an earlier local function declaration matching the filename mapping; see
 * `scripts/__tests__/filename-export-mapping.test.ts`. Not imported by any production or test module.
 */
function ReExportComponentFixture(): string {
    return 're-export-component-fixture';
}

export { ReExportComponentFixture };

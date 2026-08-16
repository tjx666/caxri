/**
 * Positive fixture proving `caxri/filename-export-mapping` recognizes a class-based component (e.g. an error boundary)
 * as satisfying the PascalCase mapping of its filename; see `scripts/__tests__/filename-export-mapping.test.ts`. Not
 * imported by any production or test module.
 */
export class ClassComponentFixture {
    render(): string {
        return 'class-component-fixture';
    }
}

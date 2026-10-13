/**
 * Virtual editor tab that renders the Benchmark board. Like Usage it has a single occurrence identity, so the path is a
 * fixed constant riding on the ordinary `{kind: 'file', path}` `PaneResource`.
 */
const BENCHMARK_TAB_PATH = 'caxri-benchmark://workbench';

export function benchmarkTabPath(): string {
    return BENCHMARK_TAB_PATH;
}

export function isBenchmarkTabPath(tabPath: string): boolean {
    return tabPath === BENCHMARK_TAB_PATH;
}

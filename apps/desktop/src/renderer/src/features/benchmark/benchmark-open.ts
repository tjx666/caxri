import { benchmarkTabPath } from '@caxri/protocol';

import { openEditorTab } from '../editor/document-commands';

/**
 * Opens the Benchmark tab in the selected Session's pane. Kept apart from the page's modules so the command palette
 * does not load the board until it opens.
 */
export function openBenchmarkPage(): void {
    openEditorTab(benchmarkTabPath());
}

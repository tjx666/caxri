import { describe, expect, it } from 'vitest';

import { runChangedFileGuardrails } from './changed-file-guardrails';

async function guardrailsRun(
    flags: Partial<Parameters<typeof runChangedFileGuardrails>[0]>,
): Promise<string[]> {
    return runChangedFileGuardrails({
        hasChangedMarkdown: false,
        hasChangedSourceCode: false,
        hasRemovedFiles: false,
        root: '/repo',
        runCapture: () => Promise.resolve(''),
        ...flags,
    });
}

describe('runChangedFileGuardrails docs-check gating', () => {
    it('skips docs-check for a code-only edit that removes nothing', async () => {
        expect(await guardrailsRun({ hasChangedSourceCode: true })).not.toContain('docs-check');
    });

    it('runs docs-check when Markdown changed', async () => {
        expect(await guardrailsRun({ hasChangedMarkdown: true })).toContain('docs-check');
    });

    it('runs docs-check when a code-only change removes or renames a file a doc may cite', async () => {
        expect(
            await guardrailsRun({ hasChangedSourceCode: true, hasRemovedFiles: true }),
        ).toContain('docs-check');
    });
});

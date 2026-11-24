import { beforeEach, describe, expect, it, vi } from 'vitest';

const { showMessageBox, writeText } = vi.hoisted(() => ({
    showMessageBox: vi.fn(),
    writeText: vi.fn(),
}));

vi.mock('electron', () => ({
    clipboard: { writeText },
    dialog: { showMessageBox },
}));
vi.mock('../../locale', () => ({
    translateMain: (key: string, parameters?: Record<string, string>) =>
        `${key}|${parameters?.folder ?? ''}`,
}));

import { confirmExternalOpen } from '../open-confirmation';

async function detailFor(path: string): Promise<string> {
    showMessageBox.mockResolvedValue({ response: 3 });
    await confirmExternalOpen(undefined, path);
    return (showMessageBox.mock.calls.at(-1)?.[0] as { detail: string }).detail;
}

describe('confirmExternalOpen', () => {
    beforeEach(() => {
        showMessageBox.mockReset();
    });

    it.each(['/tmp/dl/page.html', '/tmp/dl/PAGE.HTM'])(
        'uses the live-preview detail for %s',
        async (path) => {
            expect(await detailFor(path)).toBe('desktop.externalFile.htmlDetail|/tmp/dl');
        },
    );

    it('keeps the generic detail for other files', async () => {
        expect(await detailFor('/tmp/dl/notes.md')).toBe('desktop.externalFile.detail|/tmp/dl');
    });
});

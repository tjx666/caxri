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
    translateMain: (key: string) => key,
}));

import { confirmExternalOpen } from '../open-confirmation';

async function textFor(path: string): Promise<{ detail: string; message: string }> {
    showMessageBox.mockResolvedValue({ response: 3 });
    await confirmExternalOpen(undefined, path);
    return showMessageBox.mock.calls.at(-1)?.[0] as { detail: string; message: string };
}

describe('confirmExternalOpen', () => {
    beforeEach(() => {
        showMessageBox.mockReset();
        writeText.mockReset();
    });

    it.each(['/tmp/dl/page.html', '/tmp/dl/PAGE.HTM'])('names a page for %s', async (path) => {
        expect(await textFor(path)).toMatchObject({
            message: 'desktop.externalFile.htmlMessage',
            detail: 'desktop.externalFile.htmlDetail',
        });
    });

    it('names a file for other paths', async () => {
        expect(await textFor('/tmp/dl/notes.md')).toMatchObject({
            message: 'desktop.externalFile.message',
            detail: 'desktop.externalFile.detail',
        });
    });

    it('copies the full path on Copy Path, since the dialog no longer shows it', async () => {
        showMessageBox.mockResolvedValue({ response: 2 });
        expect(await confirmExternalOpen(undefined, '/tmp/dl/notes.md')).toBe('copy');
        expect(writeText).toHaveBeenCalledWith('/tmp/dl/notes.md');
    });
});

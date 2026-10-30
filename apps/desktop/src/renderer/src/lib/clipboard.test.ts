import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(...parameters: unknown[]) => Promise<unknown>>(() => Promise.resolve(null)),
}));

vi.mock('./caxri', () => ({ caxri: { request: mocks.request } }));

import { readClipboardFilePaths, writeClipboardText } from './clipboard';

afterEach(() => {
    vi.unstubAllGlobals();
    mocks.request.mockClear();
});

describe('writeClipboardText', () => {
    it('writes through Main when the window has the caxri bridge', async () => {
        const writeText = vi.fn(() => Promise.resolve());
        vi.stubGlobal('caxri', {});
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        await writeClipboardText('claude --resume id');
        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('clipboard.write', {
            text: 'claude --resume id',
        });
        expect(writeText).not.toHaveBeenCalled();
    });

    it('keeps the browser clipboard in a window whose preload has no caxri bridge', async () => {
        const writeText = vi.fn(() => Promise.resolve());
        vi.stubGlobal('caxri', undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        await writeClipboardText('details');
        expect(writeText).toHaveBeenCalledExactlyOnceWith('details');
        expect(mocks.request).not.toHaveBeenCalled();
    });
});

describe('readClipboardFilePaths', () => {
    it('asks Main for the files Finder copied', async () => {
        vi.stubGlobal('caxri', {});
        mocks.request.mockResolvedValueOnce({ paths: ['/Users/me/Desktop/photo.png'] });
        await expect(readClipboardFilePaths()).resolves.toEqual(['/Users/me/Desktop/photo.png']);
        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('clipboard.readFilePaths', {});
    });

    it('reads none in a window without the caxri bridge', async () => {
        vi.stubGlobal('caxri', undefined);
        await expect(readClipboardFilePaths()).resolves.toEqual([]);
        expect(mocks.request).not.toHaveBeenCalled();
    });
});

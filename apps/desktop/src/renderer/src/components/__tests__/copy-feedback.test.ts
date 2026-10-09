import { describe, expect, it, vi } from 'vitest';

import {
    copyButtonLabel,
    writeRichToClipboardWithFeedback,
    writeToClipboardWithFeedback,
} from '../copy-feedback';

describe('writeToClipboardWithFeedback', () => {
    it('resolves to copied when the clipboard write succeeds', async () => {
        const clipboard = { writeText: () => Promise.resolve() };
        await expect(writeToClipboardWithFeedback(clipboard, 'details')).resolves.toBe('copied');
    });

    it('resolves to failed instead of throwing when the clipboard write rejects', async () => {
        const clipboard = {
            writeText: () => Promise.reject(new Error('denied')),
        };
        await expect(writeToClipboardWithFeedback(clipboard, 'details')).resolves.toBe('failed');
    });
});

describe('writeRichToClipboardWithFeedback', () => {
    it('writes one item carrying both the text and the HTML flavor', async () => {
        vi.stubGlobal(
            'ClipboardItem',
            class {
                constructor(readonly items: Record<string, Blob>) {}
            },
        );
        const write = vi.fn(() => Promise.resolve());
        await expect(
            writeRichToClipboardWithFeedback({ write }, { text: '| a |', html: '<table></table>' }),
        ).resolves.toBe('copied');
        const [[item]] = write.mock.calls[0] as unknown as [[{ items: Record<string, Blob> }]];
        expect(Object.keys(item.items)).toEqual(['text/plain', 'text/html']);
        await expect(item.items['text/html']?.text()).resolves.toBe('<table></table>');
        vi.unstubAllGlobals();
    });

    it('resolves to failed when the clipboard refuses the write', async () => {
        const write = () => Promise.reject(new Error('denied'));
        await expect(
            writeRichToClipboardWithFeedback({ write }, { text: 'a', html: 'a' }),
        ).resolves.toBe('failed');
    });
});

describe('copyButtonLabel', () => {
    it('returns the idle label when idle', () => {
        expect(copyButtonLabel('idle', 'Copy details')).toBe('Copy details');
    });

    it('returns Copied when copied', () => {
        expect(copyButtonLabel('copied', 'Copy details')).toBe('Copied');
    });

    it('returns Copy failed when failed', () => {
        expect(copyButtonLabel('failed', 'Copy details')).toBe('Copy failed');
    });
});

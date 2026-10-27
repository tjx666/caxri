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
    it('hands the text and the HTML flavor to the writer together', async () => {
        const write = vi.fn(() => Promise.resolve());
        const content = { text: '| a |', html: '<table></table>' };
        await expect(writeRichToClipboardWithFeedback(write, content)).resolves.toBe('copied');
        expect(write).toHaveBeenCalledWith(content);
    });

    it('resolves to failed when the clipboard refuses the write', async () => {
        const write = () => Promise.reject(new Error('denied'));
        await expect(
            writeRichToClipboardWithFeedback(write, { text: 'a', html: 'a' }),
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

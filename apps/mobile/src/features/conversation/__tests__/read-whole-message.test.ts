import { describe, expect, it } from 'vitest';

import { isTimelineMessageClipped, readWholeMessage } from '../read-whole-message';

describe('readWholeMessage', () => {
    it('joins the slices of a long message in order', async () => {
        const text = 'a'.repeat(30);
        const offsets: number[] = [];
        const result = await readWholeMessage((offset) => {
            offsets.push(offset);
            const end = Math.min(offset + 12, text.length);
            return Promise.resolve({
                text: text.slice(offset, end),
                totalLength: text.length,
                ...(end < text.length && { nextOffset: end }),
            });
        });
        expect(result).toBe(text);
        expect(offsets).toEqual([0, 12, 24]);
    });

    it('fails rather than join slices of a message that changed between reads', async () => {
        await expect(
            readWholeMessage((offset) =>
                Promise.resolve(
                    offset === 0
                        ? { text: 'abc', totalLength: 6, nextOffset: 3 }
                        : { text: 'defgh', totalLength: 8 },
                ),
            ),
        ).rejects.toThrow('changed');
    });

    it('fails when the Server never ends the series', async () => {
        await expect(
            readWholeMessage((offset) =>
                Promise.resolve({ text: 'a', totalLength: 10_000, nextOffset: offset + 1 }),
            ),
        ).rejects.toThrow('too long');
    });

    it('treats a message at the timeline preview length as possibly cut', () => {
        expect(isTimelineMessageClipped('a'.repeat(4_095))).toBe(false);
        expect(isTimelineMessageClipped('a'.repeat(4_096))).toBe(true);
    });
});

import { z } from 'zod';

import { CaxriError } from '../transport/errors.js';

/**
 * Longest whole message, in UTF-8 bytes, the phone may read back to copy. It is its own bound rather than the 16 KiB a
 * phone may send: a reply can be far longer than anything typed on a phone, and the clipboard comfortably holds a few
 * hundred KiB while a larger one risks the platform's per-transaction clipboard limit. A longer message fails with
 * `VALIDATION` instead of copying a prefix that would pass for the whole.
 */
export const MOBILE_MESSAGE_READ_MAX_BYTES = 256 * 1_024;

/**
 * Most characters one read reply carries. A message arrives as a series of replies that each fit one gateway frame (see
 * `MOBILE_AGENT_CHAT_MAX_BYTES`), like `mobile.agentChat.readImage`'s chunks.
 */
export const MOBILE_MESSAGE_CHUNK_LENGTH = 16_000;

/**
 * Most bytes one reply's JSON-encoded text may take, which keeps a chunk heavy with quotes or control characters inside
 * the frame budget; the chunk is shortened until it fits.
 */
const MOBILE_MESSAGE_CHUNK_MAX_BYTES = 40 * 1_024;

const encoder = new TextEncoder();

/**
 * One slice of a message's whole text. `nextOffset` is where the following slice starts (in UTF-16 code units, as
 * `String.prototype.slice` counts) and is absent on the last one. `totalLength` lets the reader confirm the joined
 * slices are the text it started reading, since a streaming reply can grow between two reads.
 */
export const mobileMessageChunkSchema = z.strictObject({
    text: z.string(),
    totalLength: z.number().int().nonnegative(),
    nextOffset: z.number().int().positive().optional(),
});

export type MobileMessageChunk = z.infer<typeof mobileMessageChunkSchema>;

export const mobileMessageOffsetSchema = z.number().int().nonnegative().default(0);

/**
 * Cuts the slice of `text` that starts at `offset`, after checking the whole text may be read at all.
 */
export const readMobileMessageChunk = (text: string, offset = 0): MobileMessageChunk => {
    if (encoder.encode(text).length > MOBILE_MESSAGE_READ_MAX_BYTES)
        throw new CaxriError('VALIDATION', 'This message is too long to copy on a phone');
    if (offset > text.length) throw new CaxriError('VALIDATION', 'Read offset is past the message');
    let end = Math.min(text.length, offset + MOBILE_MESSAGE_CHUNK_LENGTH);
    while (
        end - offset > 1 &&
        encoder.encode(JSON.stringify(text.slice(offset, end))).length >
            MOBILE_MESSAGE_CHUNK_MAX_BYTES
    )
        end = offset + Math.floor((end - offset) * 0.8);
    // Never split a surrogate pair: the next slice would start with a lone low surrogate.
    const last = text.codePointAt(end - 1) ?? 0;
    if (end < text.length && end - offset > 1 && last >= 0xd8_00 && last <= 0xdb_ff) end -= 1;
    return {
        text: text.slice(offset, end),
        totalLength: text.length,
        ...(end < text.length && { nextOffset: end }),
    };
};

import type { Buffer } from 'node:buffer';

import { assertDecodablePng } from '../../acceptance/scripts/png-integrity';

const IHDR_TYPE_OFFSET = 12;
const IHDR_WIDTH_OFFSET = 16;
const IHDR_HEIGHT_OFFSET = 20;
const IHDR_END = 24;

/**
 * Reads the pixel size from the IHDR chunk, which every PNG starts with right after the 8-byte signature. This only
 * parses the header, so call `assertPromoPng` (or `assertDecodablePng`) first when the bytes are not trusted.
 */
export function pngDimensions(buffer: Buffer): { width: number; height: number } {
    if (
        buffer.length < IHDR_END ||
        buffer.readUInt32BE(0) !== 0x89_50_4e_47 ||
        buffer.readUInt32BE(4) !== 0x0d_0a_1a_0a ||
        buffer.toString('ascii', IHDR_TYPE_OFFSET, IHDR_TYPE_OFFSET + 4) !== 'IHDR'
    ) {
        throw new Error('Not a PNG: the signature or IHDR chunk is missing');
    }
    return {
        width: buffer.readUInt32BE(IHDR_WIDTH_OFFSET),
        height: buffer.readUInt32BE(IHDR_HEIGHT_OFFSET),
    };
}

/**
 * The final gate for a rendered promo image: a fully decodable PNG, exactly the expected pixel size (the canvas times
 * the render scale), and within the size budget a README can ship. Throws with the failing measurement.
 */
export async function assertPromoPng(
    buffer: Buffer,
    expected: { width: number; height: number; maxBytes: number },
): Promise<void> {
    try {
        await assertDecodablePng(buffer);
    } catch {
        throw new Error('The promo image is not a decodable PNG');
    }
    const { width, height } = pngDimensions(buffer);
    if (width !== expected.width || height !== expected.height) {
        throw new Error(
            `The promo image is ${width}x${height}, expected exactly ${expected.width}x${expected.height}`,
        );
    }
    if (buffer.length > expected.maxBytes) {
        throw new Error(
            `The promo image is ${buffer.length} bytes, over the ${expected.maxBytes} byte budget`,
        );
    }
}

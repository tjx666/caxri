import { Buffer } from 'node:buffer';
import { crc32, deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { assertPromoPng, pngDimensions } from './png-dimensions';

function chunk(type: string, data: Buffer): Buffer {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, checksum]);
}

/**
 * A valid solid-color 8-bit RGB PNG small enough to build inline.
 */
function solidPng(width: number, height: number): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 2;
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x7f)]);
    const scanlines = Buffer.concat(Array.from({ length: height }, () => row));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(scanlines)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

describe('pngDimensions', () => {
    it('reads the pixel size from the IHDR chunk', () => {
        expect(pngDimensions(solidPng(3, 2))).toEqual({ width: 3, height: 2 });
        expect(pngDimensions(solidPng(2400, 1))).toEqual({ width: 2400, height: 1 });
    });

    it('rejects a buffer that is not a PNG', () => {
        expect(() => pngDimensions(Buffer.from('not a png at all, just text bytes'))).toThrow(
            /Not a PNG/u,
        );
        expect(() => pngDimensions(Buffer.alloc(0))).toThrow(/Not a PNG/u);
        expect(() => pngDimensions(solidPng(3, 2).subarray(0, 20))).toThrow(/Not a PNG/u);
    });
});

describe('assertPromoPng', () => {
    const expected = { width: 3, height: 2, maxBytes: 1024 };

    it('accepts a decodable PNG with the exact size inside the budget', async () => {
        await expect(assertPromoPng(solidPng(3, 2), expected)).resolves.toBeUndefined();
    });

    it('rejects a PNG whose size is not exactly the expected size', async () => {
        await expect(assertPromoPng(solidPng(4, 2), expected)).rejects.toThrow(
            'is 4x2, expected exactly 3x2',
        );
    });

    it('rejects a PNG over the byte budget', async () => {
        const png = solidPng(3, 2);
        await expect(
            assertPromoPng(png, { ...expected, maxBytes: png.length - 1 }),
        ).rejects.toThrow(/over the \d+ byte budget/u);
    });

    it('rejects a corrupt or truncated PNG even when its header reads fine', async () => {
        const truncated = solidPng(3, 2).subarray(0, -8);
        expect(pngDimensions(truncated)).toEqual({ width: 3, height: 2 });
        await expect(assertPromoPng(truncated, expected)).rejects.toThrow('not a decodable PNG');
        await expect(assertPromoPng(Buffer.from('corrupt'), expected)).rejects.toThrow(
            'not a decodable PNG',
        );
    });
});

import { Buffer } from 'node:buffer';
import { promisify } from 'node:util';
import { inflate } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_DECODED_PNG_BYTES = 256 * 1024 * 1024;
const inflateAsync = promisify(inflate);
const VALID_BIT_DEPTHS = new Map<number, ReadonlySet<number>>([
    [0, new Set([1, 2, 4, 8, 16])],
    [2, new Set([8, 16])],
    [3, new Set([1, 2, 4, 8])],
    [4, new Set([8, 16])],
    [6, new Set([8, 16])],
]);
const CHANNELS_BY_COLOR_TYPE = new Map([
    [0, 1],
    [2, 3],
    [3, 1],
    [4, 2],
    [6, 4],
]);
const ADAM7_PASSES = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2],
] as const;

function crc32(content: Buffer): number {
    let crc = 0xffffffff;
    for (const byte of content) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function passSize(total: number, start: number, step: number): number {
    return total <= start ? 0 : Math.ceil((total - start) / step);
}

function validateScanlines(input: {
    bitDepth: number;
    colorType: number;
    height: number;
    interlace: number;
    scanlines: Buffer;
    width: number;
}): void {
    const channels = CHANNELS_BY_COLOR_TYPE.get(input.colorType);
    if (!channels) throw new Error('unsupported PNG color type');
    const bitsPerPixel = channels * input.bitDepth;
    const passes = input.interlace === 0 ? ([[0, 0, 1, 1]] as const) : ADAM7_PASSES;
    let offset = 0;
    for (const [startX, startY, stepX, stepY] of passes) {
        const width = passSize(input.width, startX, stepX);
        const height = passSize(input.height, startY, stepY);
        if (width === 0 || height === 0) continue;
        const rowBytes = Math.ceil((width * bitsPerPixel) / 8);
        for (let row = 0; row < height; row += 1) {
            if (offset >= input.scanlines.length || input.scanlines[offset] > 4)
                throw new Error('invalid PNG scanline filter');
            offset += rowBytes + 1;
            if (offset > input.scanlines.length) throw new Error('truncated PNG scanlines');
        }
    }
    if (offset !== input.scanlines.length) throw new Error('unexpected PNG scanline data');
}

/**
 * Validates PNG framing, chunk checksums, image metadata, compressed pixels, and scanline layout. This prevents a
 * signature-only file from being accepted as device evidence while keeping screenshot contents local and opaque.
 */
export async function assertDecodablePng(content: Buffer): Promise<void> {
    try {
        if (
            content.length > MAX_PNG_BYTES ||
            !content.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
        ) {
            throw new Error('invalid PNG signature or size');
        }
        let offset = PNG_SIGNATURE.length;
        let width = 0;
        let height = 0;
        let bitDepth = 0;
        let colorType = -1;
        let interlace = -1;
        let hasHeader = false;
        let hasEnd = false;
        let hasPalette = false;
        const imageData: Buffer[] = [];
        while (offset < content.length) {
            if (offset + 12 > content.length) throw new Error('truncated PNG chunk');
            const length = content.readUInt32BE(offset);
            const typeStart = offset + 4;
            const dataStart = typeStart + 4;
            const dataEnd = dataStart + length;
            const chunkEnd = dataEnd + 4;
            if (chunkEnd > content.length) throw new Error('truncated PNG chunk data');
            const type = content.toString('ascii', typeStart, dataStart);
            if (content.readUInt32BE(dataEnd) !== crc32(content.subarray(typeStart, dataEnd)))
                throw new Error('invalid PNG chunk checksum');
            if (!hasHeader && type !== 'IHDR') throw new Error('PNG header must be first');
            // A PNG chunk stream is ordered state, so a branch chain keeps each mutation beside its chunk contract.
            // eslint-disable-next-line unicorn/prefer-switch
            if (type === 'IHDR') {
                if (hasHeader || length !== 13) throw new Error('invalid PNG header');
                const data = content.subarray(dataStart, dataEnd);
                width = data.readUInt32BE(0);
                height = data.readUInt32BE(4);
                bitDepth = data[8];
                colorType = data[9];
                interlace = data[12];
                if (
                    width === 0 ||
                    height === 0 ||
                    !VALID_BIT_DEPTHS.get(colorType)?.has(bitDepth) ||
                    data[10] !== 0 ||
                    data[11] !== 0 ||
                    (interlace !== 0 && interlace !== 1)
                ) {
                    throw new Error('unsupported PNG header');
                }
                hasHeader = true;
            } else if (type === 'IDAT') {
                imageData.push(content.subarray(dataStart, dataEnd));
            } else if (type === 'PLTE') {
                if (length === 0 || length > 768 || length % 3 !== 0 || imageData.length > 0)
                    throw new Error('invalid PNG palette');
                hasPalette = true;
            } else if (type === 'IEND') {
                if (length !== 0 || !hasHeader || imageData.length === 0)
                    throw new Error('invalid PNG end');
                hasEnd = true;
                offset = chunkEnd;
                if (offset !== content.length) throw new Error('PNG has trailing data');
            } else if (/^[A-Z]/u.test(type)) {
                throw new Error('unsupported critical PNG chunk');
            }
            if (hasEnd) break;
            offset = chunkEnd;
        }
        if (!hasHeader || !hasEnd || imageData.length === 0) throw new Error('incomplete PNG');
        if (colorType === 3 && !hasPalette) throw new Error('indexed PNG is missing its palette');
        const scanlines = await inflateAsync(Buffer.concat(imageData), {
            maxOutputLength: MAX_DECODED_PNG_BYTES,
        });
        validateScanlines({ bitDepth, colorType, height, interlace, scanlines, width });
    } catch {
        throw new Error('Mobile Acceptance screenshot must be a decodable PNG framebuffer capture');
    }
}

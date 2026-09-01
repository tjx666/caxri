import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

export const encodeHex = (value: Uint8Array): string => bytesToHex(value);

export const decodeHex = (value: string, expectedBytes?: number): Uint8Array => {
    if (!/^[0-9a-f]+$/u.test(value) || value.length % 2 !== 0)
        throw new Error('Expected lowercase even-length hexadecimal data');
    const bytes = hexToBytes(value);
    if (expectedBytes !== undefined && bytes.length !== expectedBytes)
        throw new Error(`Expected ${expectedBytes} bytes`);
    return bytes;
};

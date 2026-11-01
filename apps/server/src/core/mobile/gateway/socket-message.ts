import { Buffer } from 'node:buffer';

import type { RawData } from 'ws';

export function messageText(data: RawData): string {
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8');
    return data.toString('utf8');
}

export function messageBytes(data: RawData): Uint8Array {
    if (Array.isArray(data)) return Buffer.concat(data);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return data;
}

export function messageByteLength(data: RawData): number {
    if (Array.isArray(data)) return data.reduce((total, value) => total + value.byteLength, 0);
    return data.byteLength;
}

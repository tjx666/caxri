import { Buffer } from 'node:buffer';

/**
 * One top-level field of a protobuf message, decoded without a schema. Length-delimited payloads stay raw bytes until a
 * caller asks for a nested message or a string, so an unread field is never copied or decoded.
 */
export interface WireField {
    number: number;
    /**
     * Varint value; fixed-width fields read as `undefined`, since nothing this reader serves uses them.
     */
    varint?: number;
    bytes?: Uint8Array;
}

const WIRE_VARINT = 0;
const WIRE_FIXED64 = 1;
const WIRE_LENGTH = 2;
const WIRE_FIXED32 = 5;

function readVarint(buffer: Uint8Array, start: number): [number, number] | undefined {
    let value = 0;
    let scale = 1;
    for (let offset = start; offset < buffer.length && offset - start < 10; offset++) {
        const byte = buffer[offset];
        // Arithmetic rather than bit shifts keeps values past 32 bits exact up to 2^53.
        value += (byte & 0x7f) * scale;
        scale *= 128;
        if (byte < 0x80) return [value, offset + 1];
    }
    return undefined;
}

/**
 * Decodes one message's top-level fields. A truncated or malformed buffer yields the fields before the fault, so a
 * record Antigravity wrote with a newer layout degrades to missing values instead of throwing.
 */
export function decodeWireFields(buffer: Uint8Array | null | undefined): WireField[] {
    const fields: WireField[] = [];
    if (!buffer) return fields;
    let offset = 0;
    while (offset < buffer.length) {
        const decoded = decodeField(buffer, offset);
        if (!decoded) break;
        if (decoded.field) fields.push(decoded.field);
        offset = decoded.next;
    }
    return fields;
}

function decodeField(
    buffer: Uint8Array,
    offset: number,
): { field?: WireField; next: number } | undefined {
    const tag = readVarint(buffer, offset);
    if (!tag) return;
    const [key, afterTag] = tag;
    const number = Math.floor(key / 8);
    if (number === 0) return;
    switch (key % 8) {
        case WIRE_VARINT: {
            const value = readVarint(buffer, afterTag);
            return value && { field: { number, varint: value[0] }, next: value[1] };
        }
        case WIRE_LENGTH: {
            const length = readVarint(buffer, afterTag);
            const end = length && length[1] + length[0];
            if (!length || !end || end > buffer.length) return;
            return { field: { number, bytes: buffer.subarray(length[1], end) }, next: end };
        }
        case WIRE_FIXED64:
        case WIRE_FIXED32: {
            const next = afterTag + (key % 8 === WIRE_FIXED64 ? 8 : 4);
            return next > buffer.length ? undefined : { field: { number }, next };
        }
        default:
            return undefined;
    }
}

export function wireMessage(fields: readonly WireField[], number: number): WireField[] | undefined {
    const field = fields.find((candidate) => candidate.number === number && candidate.bytes);
    return field ? decodeWireFields(field.bytes) : undefined;
}

export function wireString(fields: readonly WireField[] | undefined, number: number): string {
    const field = fields?.find((candidate) => candidate.number === number && candidate.bytes);
    return field?.bytes ? Buffer.from(field.bytes).toString('utf8') : '';
}

export function wireVarint(fields: readonly WireField[] | undefined, number: number): number {
    return fields?.find((candidate) => candidate.number === number)?.varint ?? 0;
}

/**
 * Every value of a repeated scalar field, whether written packed (one length-delimited run) or one tag per value.
 */
export function wireRepeatedVarint(fields: readonly WireField[], number: number): number[] {
    const values: number[] = [];
    for (const field of fields) {
        if (field.number !== number) continue;
        if (field.varint !== undefined) values.push(field.varint);
        else if (field.bytes) values.push(...packedVarints(field.bytes));
    }
    return values;
}

function packedVarints(bytes: Uint8Array): number[] {
    const values: number[] = [];
    let offset = 0;
    while (offset < bytes.length) {
        const value = readVarint(bytes, offset);
        if (!value) break;
        values.push(value[0]);
        offset = value[1];
    }
    return values;
}

/**
 * `google.protobuf.Timestamp` as epoch milliseconds, or `undefined` when absent.
 */
export function wireTimestampMs(fields: readonly WireField[] | undefined): number | undefined {
    if (!fields) return;
    const seconds = wireVarint(fields, 1);
    if (seconds <= 0) return;
    return seconds * 1000 + Math.floor(wireVarint(fields, 2) / 1_000_000);
}

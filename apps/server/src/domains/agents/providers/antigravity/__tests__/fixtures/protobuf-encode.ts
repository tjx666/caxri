/**
 * A protobuf wire encoder for synthetic Antigravity records, with no dependencies so the fake `agy` process can load it
 * too.
 */

export type ProtobufField = readonly [
    number,
    number | string | Uint8Array | readonly ProtobufField[],
];

export function varint(value: number): number[] {
    const bytes: number[] = [];
    let rest = value;
    while (rest >= 0x80) {
        bytes.push((rest % 0x80) | 0x80);
        rest = Math.floor(rest / 0x80);
    }
    bytes.push(rest);
    return bytes;
}

export function encodeMessage(fields: readonly ProtobufField[]): Uint8Array {
    const bytes: number[] = [];
    for (const [number, value] of fields) {
        if (typeof value === 'number') {
            bytes.push(...varint(number * 8), ...varint(value));
            continue;
        }
        const payload =
            typeof value === 'string'
                ? new TextEncoder().encode(value)
                : value instanceof Uint8Array
                  ? value
                  : encodeMessage(value);
        bytes.push(...varint(number * 8 + 2), ...varint(payload.length), ...payload);
    }
    return Uint8Array.from(bytes);
}

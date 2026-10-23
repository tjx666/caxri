import { Buffer } from 'node:buffer';

/**
 * Copies `text.slice(start, end)` into a string that owns its characters. V8 represents a `slice` of a long string as a
 * view that keeps the whole source alive, so a 2 KiB summary cut from a 256 KiB tool result held in a long-lived
 * projection would otherwise pin the full result. UTF-16 round-trips every code unit, lone surrogates included.
 */
export function ownedSlice(text: string, start: number, end?: number): string {
    return Buffer.from(text.slice(start, end), 'utf16le').toString('utf16le');
}

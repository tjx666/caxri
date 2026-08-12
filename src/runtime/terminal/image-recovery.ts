import { Buffer } from 'node:buffer';

export const TERMINAL_IMAGE_RECOVERY_PLACEHOLDER =
    '\r\n[Caxri inline image unavailable after restore]\r\n';
const MAX_TERMINAL_IMAGE_SEQUENCE_BYTES = 64 * 1024;

const ESC = '\x1b';
const ST = `${ESC}\\`;
const C1_ST = '\x9c';
const IIP_PREFIXES = ['File=', 'MultipartFile=', 'FilePart=', 'FileEnd='].flatMap((command) => [
    `${ESC}]1337;${command}`,
    `\x9d1337;${command}`,
]);
const KITTY_PREFIXES = [`${ESC}_G`, '\x9fG'];
const MAX_IMAGE_HEADER_CHARACTERS = 64;

type TerminatorKind = 'bel-or-st' | 'st';

interface ImageStart {
    end: number;
    index: number;
    terminator: TerminatorKind;
}

interface ImageSearch {
    incompleteIndex?: number;
    start?: ImageStart;
}

interface ImageOutputDestination {
    appendAtomic(data: string): number;
    appendBounded(data: string): number;
}

function findNextImageControl(source: string, start: number): number {
    let next = -1;
    for (const control of [ESC, '\x90', '\x9d', '\x9f']) {
        const index = source.indexOf(control, start);
        if (index >= 0 && (next < 0 || index < next)) next = index;
    }
    return next;
}

function findDcsFinal(source: string, start: number): { end: number; final: string } | undefined {
    for (let index = start; index < source.length; index += 1) {
        const code = source.charCodeAt(index);
        if ((code >= 0x30 && code <= 0x3f) || (code >= 0x20 && code <= 0x2f)) continue;
        if (code >= 0x40 && code <= 0x7e) return { end: index + 1, final: source[index] ?? '' };
        return { end: index + 1, final: '' };
    }
    return undefined;
}

function findImageStart(source: string): ImageSearch {
    let cursor = 0;
    while (cursor < source.length) {
        const index = findNextImageControl(source, cursor);
        if (index < 0) return {};
        const remainder = source.slice(index);
        const iipPrefix = IIP_PREFIXES.find((prefix) => remainder.startsWith(prefix));
        if (iipPrefix)
            return {
                start: { end: index + iipPrefix.length, index, terminator: 'bel-or-st' },
            };
        const kittyPrefix = KITTY_PREFIXES.find((prefix) => remainder.startsWith(prefix));
        if (kittyPrefix)
            return { start: { end: index + kittyPrefix.length, index, terminator: 'st' } };
        if (
            IIP_PREFIXES.some((prefix) => prefix.startsWith(remainder)) ||
            KITTY_PREFIXES.some((prefix) => prefix.startsWith(remainder))
        )
            return { incompleteIndex: index };
        const dcsPrefixLength = remainder.startsWith(`${ESC}P`)
            ? 2
            : remainder.startsWith('\x90')
              ? 1
              : 0;
        if (dcsPrefixLength) {
            const final = findDcsFinal(source, index + dcsPrefixLength);
            if (!final) {
                if (remainder.length > MAX_IMAGE_HEADER_CHARACTERS)
                    return {
                        start: { end: index + dcsPrefixLength, index, terminator: 'st' },
                    };
                return { incompleteIndex: index };
            }
            if (final.final === 'q') return { start: { end: final.end, index, terminator: 'st' } };
            cursor = final.end;
            continue;
        }
        if (`${ESC}P`.startsWith(remainder)) return { incompleteIndex: index };
        cursor = index + 1;
    }
    return {};
}

function findTerminator(
    source: string,
    kind: TerminatorKind,
): { index: number; length: number } | undefined {
    const escapedSt = source.indexOf(ST);
    const c1St = source.indexOf(C1_ST);
    const st = escapedSt < 0 ? c1St : c1St < 0 || escapedSt < c1St ? escapedSt : c1St;
    const stLength = st === escapedSt ? ST.length : C1_ST.length;
    if (kind === 'st') return st < 0 ? undefined : { index: st, length: stLength };
    const bel = source.indexOf('\x07');
    if (bel < 0 && st < 0) return undefined;
    if (bel >= 0 && (st < 0 || bel < st)) return { index: bel, length: 1 };
    return { index: st, length: stLength };
}

/**
 * Removes image payloads from Runtime-owned recovery state while the raw bytes continue to the
 * attached Renderer. Chunk boundaries and oversized/incomplete sequences stay bounded and resolve
 * to one content-free placeholder, so SQLite and diagnostics never retain image contents.
 */
export class TerminalImageRecoveryFilter {
    private buffer = '';
    private capturing: TerminatorKind | undefined;
    private discarding: TerminatorKind | undefined;

    constructor(private readonly maximumSequenceCharacters = MAX_TERMINAL_IMAGE_SEQUENCE_BYTES) {
        if (!Number.isInteger(maximumSequenceCharacters) || maximumSequenceCharacters < 1)
            throw new RangeError('Terminal image recovery limit must be a positive integer');
    }

    push(data: string): string {
        if (!data) return '';
        this.buffer += data;
        let output = '';
        while (this.buffer) {
            if (this.discarding) {
                const terminator = findTerminator(this.buffer, this.discarding);
                if (!terminator) {
                    this.buffer = this.buffer.endsWith(ESC) ? ESC : '';
                    return output;
                }
                this.buffer = this.buffer.slice(terminator.index + terminator.length);
                this.discarding = undefined;
                continue;
            }
            if (this.capturing) {
                const terminator = findTerminator(this.buffer, this.capturing);
                if (terminator) {
                    this.buffer = this.buffer.slice(terminator.index + terminator.length);
                    this.capturing = undefined;
                    output += TERMINAL_IMAGE_RECOVERY_PLACEHOLDER;
                    continue;
                }
                if (this.buffer.length > this.maximumSequenceCharacters) {
                    this.discarding = this.capturing;
                    this.capturing = undefined;
                    this.buffer = this.buffer.endsWith(ESC) ? ESC : '';
                    output += TERMINAL_IMAGE_RECOVERY_PLACEHOLDER;
                }
                return output;
            }
            const search = findImageStart(this.buffer);
            if (search.start) {
                output += this.buffer.slice(0, search.start.index);
                this.buffer = this.buffer.slice(search.start.end);
                this.capturing = search.start.terminator;
                continue;
            }
            if (search.incompleteIndex !== undefined) {
                output += this.buffer.slice(0, search.incompleteIndex);
                this.buffer = this.buffer.slice(search.incompleteIndex);
                return output;
            }
            output += this.buffer;
            this.buffer = '';
        }
        return output;
    }

    finish(): string {
        const output = this.capturing
            ? TERMINAL_IMAGE_RECOVERY_PLACEHOLDER
            : this.discarding
              ? ''
              : this.buffer;
        this.buffer = '';
        this.capturing = undefined;
        this.discarding = undefined;
        return output;
    }
}

/**
 * Keeps live image controls atomic across PTY chunks and Renderer backpressure. An image sequence
 * is delivered whole or counted as wholly dropped; oversized/malformed sequences are discarded
 * through their terminator so later text can never be consumed as image payload.
 */
export class TerminalImageOutputFilter {
    private buffer = '';
    private capturing: TerminatorKind | undefined;
    private discarding: TerminatorKind | undefined;

    constructor(private readonly maximumSequenceBytes = MAX_TERMINAL_IMAGE_SEQUENCE_BYTES) {
        if (!Number.isInteger(maximumSequenceBytes) || maximumSequenceBytes < 1)
            throw new RangeError('Terminal image output limit must be a positive integer');
    }

    push(data: string, destination: ImageOutputDestination): number {
        if (!data) return 0;
        this.buffer += data;
        let droppedBytes = 0;
        while (this.buffer) {
            if (this.discarding) {
                const terminator = findTerminator(this.buffer, this.discarding);
                if (!terminator) {
                    const retained = this.buffer.endsWith(ESC) ? ESC : '';
                    droppedBytes += Buffer.byteLength(
                        this.buffer.slice(0, this.buffer.length - retained.length),
                        'utf8',
                    );
                    this.buffer = retained;
                    return droppedBytes;
                }
                const end = terminator.index + terminator.length;
                droppedBytes += Buffer.byteLength(this.buffer.slice(0, end), 'utf8');
                this.buffer = this.buffer.slice(end);
                this.discarding = undefined;
                continue;
            }
            if (this.capturing) {
                const terminator = findTerminator(this.buffer, this.capturing);
                if (terminator) {
                    const end = terminator.index + terminator.length;
                    const sequence = this.buffer.slice(0, end);
                    const sequenceBytes = Buffer.byteLength(sequence, 'utf8');
                    droppedBytes +=
                        sequenceBytes > this.maximumSequenceBytes
                            ? sequenceBytes
                            : destination.appendAtomic(sequence);
                    this.buffer = this.buffer.slice(end);
                    this.capturing = undefined;
                    continue;
                }
                if (Buffer.byteLength(this.buffer, 'utf8') > this.maximumSequenceBytes) {
                    this.discarding = this.capturing;
                    this.capturing = undefined;
                    const retained = this.buffer.endsWith(ESC) ? ESC : '';
                    droppedBytes += Buffer.byteLength(
                        this.buffer.slice(0, this.buffer.length - retained.length),
                        'utf8',
                    );
                    this.buffer = retained;
                }
                return droppedBytes;
            }
            const search = findImageStart(this.buffer);
            if (search.start) {
                droppedBytes += destination.appendBounded(this.buffer.slice(0, search.start.index));
                this.buffer = this.buffer.slice(search.start.index);
                this.capturing = search.start.terminator;
                continue;
            }
            if (search.incompleteIndex !== undefined) {
                droppedBytes += destination.appendBounded(
                    this.buffer.slice(0, search.incompleteIndex),
                );
                this.buffer = this.buffer.slice(search.incompleteIndex);
                return droppedBytes;
            }
            droppedBytes += destination.appendBounded(this.buffer);
            this.buffer = '';
        }
        return droppedBytes;
    }

    finish(): number {
        const droppedBytes = Buffer.byteLength(this.buffer, 'utf8');
        this.buffer = '';
        this.capturing = undefined;
        this.discarding = undefined;
        return droppedBytes;
    }
}

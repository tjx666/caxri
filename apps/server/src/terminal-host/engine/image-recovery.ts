import { Buffer } from 'node:buffer';

export const TERMINAL_IMAGE_RECOVERY_PLACEHOLDER =
    '\r\n[Caxri inline image unavailable after restore]\r\n';
const MAX_TERMINAL_IMAGE_SEQUENCE_BYTES = 64 * 1024;

const ESC = '\u{1B}';
const ST = `${ESC}\\`;
const C1_ST = '\u{9C}';
const IIP_PREFIXES = ['File=', 'MultipartFile=', 'FilePart=', 'FileEnd='].flatMap((command) => [
    `${ESC}]1337;${command}`,
    `\u{9D}1337;${command}`,
]);
const KITTY_PREFIXES = [`${ESC}_G`, '\u{9F}G'];
const MAX_IMAGE_HEADER_CHARACTERS = 64;
/**
 * Kitty control data (`key=value,...`) is short; a longer header is treated as a placement to stay conservative.
 */
const MAX_KITTY_CONTROL_CHARACTERS = 256;
/**
 * Kitty graphics actions that put pixels on screen. Everything else — the default transmit-only `t`, queries (`q`),
 * deletions (`d`), and animation controls (`f`, `a`, `c`) — leaves no visible cell content to recover. This matters
 * because capability probes such as Claude Code's startup `a=q` query must not leave a placeholder, and continuation
 * chunks (`m=1`/`m=0` without `a=`) must not repeat the placeholder of the image they belong to.
 *
 * @see https://sw.kovidgoyal.net/kitty/graphics-protocol/#control-data-reference
 */
const KITTY_PLACEMENT_ACTIONS = new Set(['T', 'p']);

type TerminatorKind = 'bel-or-st' | 'st';

interface ImageStart {
    end: number;
    index: number;
    /**
     * Kitty controls defer the placeholder decision until their control data is known.
     */
    kitty?: boolean;
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
    for (const control of [ESC, '\u{90}', '\u{9D}', '\u{9F}']) {
        const index = source.indexOf(control, start);
        if (index !== -1 && (next < 0 || index < next)) next = index;
    }
    return next;
}

function findDcsFinal(source: string, start: number): { end: number; final: string } | undefined {
    for (let index = start; index < source.length; index += 1) {
        const code = source.codePointAt(index) ?? -1;
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
            return {
                start: { end: index + kittyPrefix.length, index, kitty: true, terminator: 'st' },
            };
        if (
            IIP_PREFIXES.some((prefix) => prefix.startsWith(remainder)) ||
            KITTY_PREFIXES.some((prefix) => prefix.startsWith(remainder))
        )
            return { incompleteIndex: index };
        const dcsPrefixLength = remainder.startsWith(`${ESC}P`)
            ? 2
            : remainder.startsWith('\u{90}')
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
    const st = escapedSt === -1 ? c1St : c1St === -1 || escapedSt < c1St ? escapedSt : c1St;
    const stLength = st === escapedSt ? ST.length : C1_ST.length;
    if (kind === 'st') return st < 0 ? undefined : { index: st, length: stLength };
    const bel = source.indexOf('\u{7}');
    if (bel === -1 && st < 0) return undefined;
    if (bel !== -1 && (st < 0 || bel < st)) return { index: bel, length: 1 };
    return { index: st, length: stLength };
}

/**
 * Returns whether a Kitty graphics control places an image, or `undefined` while its control data is still incomplete.
 * `body` starts right after the `ESC _ G` introducer.
 */
function resolveKittyPlacement(body: string): boolean | undefined {
    const ends = [';', ESC, C1_ST]
        .map((delimiter) => body.indexOf(delimiter))
        .filter((index) => index >= 0);
    if (ends.length === 0) return body.length > MAX_KITTY_CONTROL_CHARACTERS ? true : undefined;
    const action = body
        .slice(0, Math.min(...ends))
        .split(',')
        .find((entry) => entry.startsWith('a='))
        ?.slice(2);
    return KITTY_PLACEMENT_ACTIONS.has(action ?? 't');
}

/**
 * Removes image payloads from Server-owned recovery state while the raw bytes continue to the attached Renderer. Chunk
 * boundaries and oversized/incomplete sequences stay bounded and resolve to one content-free placeholder, so SQLite and
 * diagnostics never retain image contents.
 */
export class TerminalImageRecoveryFilter {
    private buffer = '';
    private capturing: TerminatorKind | undefined;
    private discarding: TerminatorKind | undefined;
    /**
     * Whether the captured control leaves visible content; `undefined` until a Kitty header is complete.
     */
    private placement: boolean | undefined;

    constructor(private readonly maximumSequenceCharacters = MAX_TERMINAL_IMAGE_SEQUENCE_BYTES) {
        if (!Number.isSafeInteger(maximumSequenceCharacters) || maximumSequenceCharacters < 1)
            throw new RangeError('Terminal image recovery limit must be a positive integer');
    }

    /**
     * An unresolved Kitty header at this point was cut short, so it keeps the conservative placeholder.
     */
    private endCapture(): string {
        const placement = this.placement ?? true;
        this.capturing = undefined;
        this.placement = undefined;
        return placement ? TERMINAL_IMAGE_RECOVERY_PLACEHOLDER : '';
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
                this.placement ??= resolveKittyPlacement(this.buffer);
                const terminator = findTerminator(this.buffer, this.capturing);
                if (terminator) {
                    this.buffer = this.buffer.slice(terminator.index + terminator.length);
                    output += this.endCapture();
                    continue;
                }
                if (this.buffer.length > this.maximumSequenceCharacters) {
                    this.discarding = this.capturing;
                    this.buffer = this.buffer.endsWith(ESC) ? ESC : '';
                    output += this.endCapture();
                }
                return output;
            }
            const search = findImageStart(this.buffer);
            if (search.start) {
                output += this.buffer.slice(0, search.start.index);
                this.buffer = this.buffer.slice(search.start.end);
                this.capturing = search.start.terminator;
                this.placement = search.start.kitty ? undefined : true;
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
        const output = this.capturing ? this.endCapture() : this.discarding ? '' : this.buffer;
        this.buffer = '';
        this.capturing = undefined;
        this.discarding = undefined;
        return output;
    }
}

/**
 * Live counterpart to {@link TERMINAL_IMAGE_RECOVERY_PLACEHOLDER}: inserted in place of an image Caxri's own size policy
 * refused to deliver, so the gap reads as a deliberate, explained decision instead of folding into the generic `[N
 * bytes dropped by output backpressure]` notice, which is reserved for genuine PTY output-queue congestion.
 */
export const TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER =
    '\r\n[Caxri dropped an inline image: it exceeds the size limit]\r\n';

/**
 * Keeps live image controls atomic across PTY chunks and Renderer backpressure. An image sequence is delivered whole;
 * one Caxri sized it out, the returned byte count below reflects only genuine `destination` backpressure (queue
 * capacity), never the size of the image itself — that distinction is what lets the caller keep its own backpressure
 * counter honest.
 */
export class TerminalImageOutputFilter {
    private buffer = '';
    private capturing: TerminatorKind | undefined;
    private discarding: TerminatorKind | undefined;

    constructor(private readonly maximumSequenceBytes = MAX_TERMINAL_IMAGE_SEQUENCE_BYTES) {
        if (!Number.isSafeInteger(maximumSequenceBytes) || maximumSequenceBytes < 1)
            throw new RangeError('Terminal image output limit must be a positive integer');
    }

    /**
     * Returns only bytes `destination` itself refused (real output-queue backpressure). A sequence Caxri's own size
     * policy refuses is replaced by one {@link TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER} instead of being tallied as
     * dropped bytes, so the Renderer sees an honest inline reason rather than a generic byte count.
     */
    push(data: string, destination: ImageOutputDestination): number {
        if (!data) return 0;
        this.buffer += data;
        let backpressureBytes = 0;
        while (this.buffer) {
            if (this.discarding) {
                const terminator = findTerminator(this.buffer, this.discarding);
                if (!terminator) {
                    this.buffer = this.buffer.endsWith(ESC) ? ESC : '';
                    return backpressureBytes;
                }
                const end = terminator.index + terminator.length;
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
                    backpressureBytes +=
                        sequenceBytes > this.maximumSequenceBytes
                            ? destination.appendAtomic(TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER)
                            : destination.appendAtomic(sequence);
                    this.buffer = this.buffer.slice(end);
                    this.capturing = undefined;
                    continue;
                }
                if (Buffer.byteLength(this.buffer, 'utf8') > this.maximumSequenceBytes) {
                    this.discarding = this.capturing;
                    this.capturing = undefined;
                    this.buffer = this.buffer.endsWith(ESC) ? ESC : '';
                    backpressureBytes += destination.appendAtomic(
                        TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER,
                    );
                }
                return backpressureBytes;
            }
            const search = findImageStart(this.buffer);
            if (search.start) {
                backpressureBytes += destination.appendBounded(
                    this.buffer.slice(0, search.start.index),
                );
                this.buffer = this.buffer.slice(search.start.index);
                this.capturing = search.start.terminator;
                continue;
            }
            if (search.incompleteIndex !== undefined) {
                backpressureBytes += destination.appendBounded(
                    this.buffer.slice(0, search.incompleteIndex),
                );
                this.buffer = this.buffer.slice(search.incompleteIndex);
                return backpressureBytes;
            }
            backpressureBytes += destination.appendBounded(this.buffer);
            this.buffer = '';
        }
        return backpressureBytes;
    }

    /**
     * Called at teardown (detach/close/exit). `destination` is only passed when the caller still intends to flush its
     * queue afterwards (a genuine close/exit); a bare detach passes none, since no Renderer view remains to read the
     * placeholder and appending it would just leave stale content sitting in a queue nobody drains.
     */
    finish(destination?: ImageOutputDestination): number {
        const wasCapturing = this.capturing !== undefined;
        this.buffer = '';
        this.capturing = undefined;
        this.discarding = undefined;
        if (!wasCapturing || !destination) return 0;
        return destination.appendAtomic(TERMINAL_IMAGE_OUTPUT_TRUNCATED_PLACEHOLDER);
    }
}

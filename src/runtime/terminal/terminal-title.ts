import { throttle } from 'es-toolkit';

import type { RuntimeEvent } from '../../shared/ipc/events';
import type { TerminalTitleObserver } from './screen';

/**
 * The narrow persistence surface a title listener needs, kept to one method so the listener stays testable without a
 * database.
 */
interface TerminalTitleStore {
    setTerminalTitle: (id: string, title: string) => boolean;
}

/**
 * Upper bound on a PTY-authored Terminal title. Long enough for a path plus a command, short enough that a runaway
 * program cannot push kilobytes through `state.changed` on every prompt.
 */
export const MAX_TERMINAL_TITLE_LENGTH = 120;

/**
 * Minimum gap between two persisted title updates for one Terminal. Shells rewrite the title on every prompt and some
 * programs animate it (progress reported in the title bar is a common trick), so the raw signal is far too chatty for a
 * durable write plus a Renderer broadcast.
 */
export const TERMINAL_TITLE_THROTTLE_MS = 250;

/**
 * Zero-width and bidirectional formatting characters, which render as nothing (or reorder their neighbours) and would
 * let any process disguise one Terminal as another in the tab strip.
 *
 * `Cf` is the whole invisible-formatting category; ZWNJ/ZWJ are carved back out because they are load-bearing inside
 * legitimate text — emoji sequences and Indic scripts both fall apart without them.
 */
const INVISIBLE_FORMATTING = /\p{Cf}/u;
const ZERO_WIDTH_NON_JOINER = 0x20_0c;
const ZERO_WIDTH_JOINER = 0x20_0d;

function isInvisibleFormatting(character: string): boolean {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === ZERO_WIDTH_NON_JOINER || codePoint === ZERO_WIDTH_JOINER) return false;
    return INVISIBLE_FORMATTING.test(character);
}

/**
 * C0 (`0x00`-`0x1F`), DEL, and C1 (`0x80`-`0x9F`) control characters, which a title payload must never carry into a tab
 * label. Written as a code-point test rather than a character-class literal so no source file has to contain the raw
 * control characters themselves.
 */
function isControlCharacter(character: string): boolean {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/**
 * Reduces a raw OSC 0/2 window-title payload to something safe to persist and render, or `undefined` when the payload
 * carries no usable title and the Terminal should keep the one it already has.
 *
 * PTY output is untrusted by definition: a title can arrive with control characters, embedded newlines, invisible
 * formatting, or arbitrary length, and it ends up in a Renderer tab label, so it is flattened to a single line of
 * printable text here rather than at any display site. A single pass that stops at the length cap keeps a
 * multi-megabyte payload (xterm accepts OSC strings far larger than any real title) from being materialised and
 * rescanned in full on every prompt.
 */
export function normalizeTerminalTitle(raw: string): string | undefined {
    let normalized = '';
    let hasPendingSpace = false;
    for (const character of raw) {
        if (isInvisibleFormatting(character)) continue;
        if (isControlCharacter(character) || /\s/u.test(character)) {
            // Deferred rather than appended, so leading and trailing runs collapse to nothing at no extra cost.
            hasPendingSpace = normalized.length > 0;
            continue;
        }
        const addedLength = (hasPendingSpace ? 1 : 0) + character.length;
        if (normalized.length + addedLength > MAX_TERMINAL_TITLE_LENGTH) break;
        if (hasPendingSpace) {
            normalized += ' ';
            hasPendingSpace = false;
        }
        normalized += character;
    }
    return normalized || undefined;
}

/**
 * Persists a PTY-reported title and republishes the Terminal record, which is how a tab label learns what a Shell or
 * Agent CLI is actually doing — the same OSC 0/2 signal every terminal emulator has used since xterm.
 *
 * `setTerminalTitle` reports whether anything changed, so the prompt-by-prompt repeat of an unchanged title costs one
 * comparison and no broadcast. Leading-edge delivery keeps a Terminal's first title instant; the trailing edge
 * guarantees the last title of a burst is the one that sticks. The screen that owns this observer cancels the pending
 * trailing delivery when it is disposed — see `TerminalTitleObserver`.
 */
export function createTerminalTitleListener(
    terminalId: string,
    database: TerminalTitleStore,
    emit: (event: RuntimeEvent) => void,
    throttleMs = TERMINAL_TITLE_THROTTLE_MS,
): TerminalTitleObserver {
    const publish = throttle(
        (title: string) => {
            if (!database.setTerminalTitle(terminalId, title)) return;
            emit({
                event: 'state.changed',
                payload: { kind: 'records', sessionIds: [], terminalIds: [terminalId] },
            });
        },
        throttleMs,
        { edges: ['leading', 'trailing'] },
    );
    return Object.assign(
        (raw: string) => {
            const title = normalizeTerminalTitle(raw);
            if (title) publish(title);
        },
        { cancel: () => publish.cancel() },
    );
}

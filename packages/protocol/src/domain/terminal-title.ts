import type { TerminalRecord } from './domain.js';

/**
 * Upper bound on a persisted Terminal title, whichever source produced it. Long enough for a path plus a command, short
 * enough that a runaway program cannot push kilobytes through `state.changed` on every prompt.
 */
export const MAX_TERMINAL_TITLE_LENGTH = 120;

/**
 * Zero-width and bidirectional formatting characters, which render as nothing (or reorder their neighbours) and would
 * let any process disguise one Terminal as another in the tab strip.
 *
 * `Cf` is the whole invisible-formatting category; ZWNJ/ZWJ are carved back out because they are load-bearing inside
 * legitimate text: emoji sequences and Indic scripts both fall apart without them.
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
 * Reduces a raw Terminal-title payload to something safe to persist and render, or `undefined` when the payload carries
 * no usable title and the Terminal should keep the one it already has.
 *
 * Both title sources are untrusted: an OSC 0/2 payload is arbitrary PTY output, and an Agent conversation name is
 * whatever text a model wrote into a provider state store. Either can arrive with control characters, embedded
 * newlines, invisible formatting, or arbitrary length, and both end up in a Renderer tab label, so they are flattened
 * to a single line of printable text here rather than at any display site. A single pass that stops at the length cap
 * keeps a multi-megabyte payload (xterm accepts OSC strings far larger than any real title) from being materialised and
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
 * `user@host:` is what a default `zsh`/`bash` prompt hook puts in front of every OSC 0/2 title. On a local Terminal it
 * is the same string for every tab in the window, so it is pure noise that pushes the part that actually identifies the
 * Terminal past the truncation point.
 */
const HOST_PREFIX = /^[^\s:@]+@[^\s:]+:\s*/u;

/**
 * A filesystem path rooted at `/`, `~/`, `./`, or `../`.
 *
 * Compression is gated on this shape rather than on the absence of spaces: a directory name may well contain a space
 * (`~/Code/My Project/src`), while plenty of prose contains a slash (`Fix/verify/now`) and every URL contains several.
 * Requiring an explicit root marker is what separates the two without guessing.
 */
const ROOTED_PATH = /^(?:~|\.{1,2})?\//u;

/**
 * Trailing segments a compressed label keeps after the ellipsis; the root marker (`~`, `.`, or the empty string an
 * absolute path splits into) is always kept in front of it.
 */
const KEPT_TRAILING_SEGMENTS = 1;

/**
 * Shortest path worth compressing. At three segments the ellipsis is no shorter than the segment it replaces, so
 * `~/code/caxri` stays intact rather than becoming a less informative `~/…/caxri`.
 */
const MINIMUM_COMPRESSED_SEGMENTS = 4;

/**
 * Turns a PTY-reported window title into the label a tab shows.
 *
 * Terminal titles are overwhelmingly `user@host: /some/deep/path`, and a tab is far too narrow to render that: plain
 * end-truncation would show every tab as the same host prefix. This keeps the identifying tail (the directory the
 * Terminal is actually in), the way iTerm2 and VS Code both compress a path for a narrow slot. The untouched title
 * stays available as the tab's tooltip and accessible name.
 */
export function terminalTabLabel(title: string): string {
    const withoutHost = title.replace(HOST_PREFIX, '').trim();
    const label = withoutHost || title;
    if (!ROOTED_PATH.test(label)) return label;
    // A shell reports `~/code/caxri/` and `~/code/caxri` for the same directory; the empty tail segment is not a name.
    const segments = label.replace(/\/$/u, '').split('/');
    if (segments.length < MINIMUM_COMPRESSED_SEGMENTS) return label;
    return [segments[0], '…', ...segments.slice(-KEPT_TRAILING_SEGMENTS)].join('/');
}

/**
 * The title a Terminal's tab shows.
 *
 * A Shell has no identity beyond what its process announces, so its OSC 0/2 title outranks the generic stable one. An
 * Agent Terminal does have one: `title` carries the Agent conversation name, which is what the tab must keep showing
 * even while the Agent CLI paints its own status string into the window title.
 */
export function terminalDisplayTitle(
    terminal: Pick<TerminalRecord, 'provider' | 'ptyTitle' | 'title'>,
): string {
    return terminal.provider ? terminal.title : (terminal.ptyTitle ?? terminal.title);
}

const ESC = '\u{1B}';
const BEL = '\u{7}';
const ST = `${ESC}\\`;

export type TerminalColorQuerySlot = 10 | 11;

/**
 * The two default-color queries (OSC 10 foreground, OSC 11 background), each with both legal terminators.
 */
const QUERY_FORMS: Array<{ sequence: string; slot: TerminalColorQuerySlot; terminator: string }> = (
    [10, 11] as const
).flatMap((slot) =>
    [BEL, ST].map((terminator) => ({
        sequence: `${ESC}]${slot};?${terminator}`,
        slot,
        terminator,
    })),
);

/**
 * Answers xterm-style OSC 10/11 default-color queries at the PTY boundary instead of letting the Renderer's xterm.js do
 * it.
 *
 * Agent CLIs probe these colors immediately after spawn: Codex, for example, gives the terminal only ~100ms before it
 * permanently assumes colors are unavailable and drops its shaded composer background (`terminal_probe.rs` in
 * codex-rs). Caxri PTYs start in the Server while the Renderer pane attaches later and replays the snapshot, so an
 * xterm.js-produced reply always arrives long after that deadline. This filter recognizes the query in the raw output
 * stream, strips it (so the replayed snapshot cannot make xterm.js emit a duplicate, late reply), and lets the owner
 * respond immediately with the active theme's colors.
 *
 * Only the query form (`ESC ] 10/11 ; ? BEL|ST`) is intercepted; set/reset forms pass through.
 */
export class TerminalColorQueryResponder {
    private buffer = '';

    constructor(
        private readonly onQuery: (slot: TerminalColorQuerySlot, terminator: string) => void,
    ) {}

    /**
     * Filters one output chunk, invoking `onQuery` for each complete query found.
     */
    push(data: string): string {
        if (!data) return '';
        this.buffer += data;
        let output = '';
        let cursor = 0;
        while (cursor < this.buffer.length) {
            const index = this.buffer.indexOf(ESC, cursor);
            if (index === -1) {
                output += this.buffer.slice(cursor);
                this.buffer = '';
                return output;
            }
            output += this.buffer.slice(cursor, index);
            const remainder = this.buffer.slice(index);
            const match = QUERY_FORMS.find((form) => remainder.startsWith(form.sequence));
            if (match) {
                this.onQuery(match.slot, match.terminator);
                cursor = index + match.sequence.length;
                continue;
            }
            if (QUERY_FORMS.some((form) => form.sequence.startsWith(remainder))) {
                /**
                 * A query split across chunks: hold the partial tail until more bytes decide it.
                 */
                this.buffer = remainder;
                return output;
            }
            output += ESC;
            cursor = index + 1;
        }
        this.buffer = '';
        return output;
    }

    /**
     * Releases a held partial sequence when the stream ends without completing it.
     */
    finish(): string {
        const output = this.buffer;
        this.buffer = '';
        return output;
    }
}

/**
 * Formats `#rrggbb` as the 16-bit-per-channel `rgb:` reply xterm and OSC probers expect.
 */
export function oscColorReply(
    slot: TerminalColorQuerySlot,
    hexColor: string,
    terminator: string,
): string | undefined {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hexColor);
    if (!match) return undefined;
    const [, red, green, blue] = match;
    return `${ESC}]${slot};rgb:${red}${red}/${green}${green}/${blue}${blue}${terminator}`;
}

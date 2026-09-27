import type { TerminalWheelInput } from '@caxri/protocol';
import type { Terminal as HeadlessTerminal } from '@xterm/headless';

/**
 * The encodings xterm itself switches on DECSET/DECRST: SGR (1006) is encoded here, while SGR pixel (1016) reports are
 * refused because the Host has no pixel coordinates. xterm ignores UTF-8 (1005) and urxvt (1015), so they do not change
 * the tracked encoding either.
 */
const MOUSE_ENCODINGS = new Map<number, 'sgr' | 'unsupported'>([
    [1006, 'sgr'],
    [1016, 'unsupported'],
]);
const WHEEL_UP_BUTTON = 64;
const WHEEL_DOWN_BUTTON = 65;
/**
 * The default X10-style coordinate encoding adds 32 to a single byte, so cells past 223 cannot be reported.
 */
const DEFAULT_ENCODING_MAX_CELL = 223;

/**
 * Tracks the mouse report encoding, which xterm keeps private, from the parsed DECSET/DECRST stream. Handlers return
 * `false` so xterm still applies every mode itself.
 */
export class TerminalMouseWheelEncoder {
    private encoding: 'default' | 'sgr' | 'unsupported' = 'default';

    constructor(private readonly terminal: HeadlessTerminal) {
        const track = (isEnabled: boolean) => (parameters: Array<number | number[]>) => {
            for (const parameter of parameters) {
                const encoding = typeof parameter === 'number' && MOUSE_ENCODINGS.get(parameter);
                if (encoding) this.encoding = isEnabled ? encoding : 'default';
            }
            return false;
        };
        terminal.parser.registerCsiHandler({ prefix: '?', final: 'h' }, track(true));
        terminal.parser.registerCsiHandler({ prefix: '?', final: 'l' }, track(false));
        terminal.parser.registerEscHandler({ final: 'c' }, () => {
            this.encoding = 'default';
            return false;
        });
    }

    /**
     * Encodes wheel steps the way xterm reports a wheel for the application's current modes: mouse reports while it
     * tracks the mouse, otherwise cursor keys on the alternate screen. Returns `null` when the application accepts
     * neither, including X10 tracking, which never reports the wheel.
     */
    encode({ col, lines, row }: TerminalWheelInput): string | null {
        const count = Math.abs(lines);
        const mode = this.terminal.modes.mouseTrackingMode;
        if (mode === 'none') {
            if (this.terminal.buffer.active.type !== 'alternate') return null;
            const prefix = this.terminal.modes.applicationCursorKeysMode ? '\u{1B}O' : '\u{1B}[';
            return `${prefix}${lines < 0 ? 'A' : 'B'}`.repeat(count);
        }
        if (mode === 'x10' || this.encoding === 'unsupported') return null;
        const button = lines < 0 ? WHEEL_UP_BUTTON : WHEEL_DOWN_BUTTON;
        const x = Math.min(Math.max(1, col), this.terminal.cols);
        const y = Math.min(Math.max(1, row), this.terminal.rows);
        if (this.encoding === 'sgr') return `\u{1B}[<${button};${x};${y}M`.repeat(count);
        if (x > DEFAULT_ENCODING_MAX_CELL || y > DEFAULT_ENCODING_MAX_CELL) return null;
        return `\u{1B}[M${String.fromCodePoint(32 + button, 32 + x, 32 + y)}`.repeat(count);
    }
}

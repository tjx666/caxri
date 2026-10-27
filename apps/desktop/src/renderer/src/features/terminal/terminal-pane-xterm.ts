import type { ProcessState, ThemeTokens } from '@caxri/protocol';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { ProgressAddon } from '@xterm/addon-progress';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { ITerminalAddon } from '@xterm/xterm';
import { Terminal } from '@xterm/xterm';

import { translate } from '../../i18n';
import { writeClipboardText } from '../../lib/clipboard';
import { pushToast } from '../../stores/toasts';
import { beginRendererPerformanceTerminalStage } from '../renderer-performance/controller';
import { ControlledOsc52Clipboard } from './terminal-osc52-clipboard';
import { reportTerminalOsc52ClipboardWriteFailure } from './terminal-osc52-clipboard-diagnostics';
import {
    onError,
    OSC52_BLOCK_MESSAGES,
    xtermThemeWithoutOverviewRulerBorder,
} from './terminal-pane-support';

/**
 * The settings the new instance is constructed with. Read once, at construction; later changes reach the live instance
 * through the pane runtime's option-syncing effects rather than through another instance.
 */
interface TerminalPaneXtermInitialOptions {
    fontFamily: string;
    fontSize: number;
    longPastePending: boolean;
    processState: ProcessState;
    scrollback: number;
    terminalTheme: ThemeTokens['terminal'] | undefined;
    wordSeparators: string;
}

/**
 * The state the clipboard addon must read at the moment a program writes, not at construction: OSC 52 can be toggled in
 * Settings while the Terminal runs, and the pane can be reattached to another Terminal.
 */
interface TerminalPaneXtermLiveOptions {
    osc52ClipboardWrite: boolean;
    terminalId: string;
}

interface CreateTerminalPaneXtermOptions {
    container: HTMLElement;
    initial: TerminalPaneXtermInitialOptions;
    latest: () => TerminalPaneXtermLiveOptions;
    /**
     * Owned by the pane's search hook, which keeps the addon across attach epochs; it is loaded here only so every
     * addon reaches xterm before `open()`.
     */
    search: ITerminalAddon;
}

interface TerminalPaneXterm {
    fit: FitAddon;
    progress: ProgressAddon;
    xterm: Terminal;
}

/**
 * Builds one pane's xterm instance with its addons and puts it in the DOM.
 *
 * The whole body is bracketed as the `xterm-create` performance stage: it is the Renderer half of putting a Terminal on
 * screen, and a Session switch that reuses a kept-alive pane must not reach it at all (issue #657), which is what the
 * receipt makes checkable.
 */
export function createTerminalPaneXterm({
    container,
    initial,
    latest,
    search,
}: CreateTerminalPaneXtermOptions): TerminalPaneXterm {
    const settleXtermCreate = beginRendererPerformanceTerminalStage('xterm-create');
    /**
     * Xterm names its input field and its screen-reader overflow notice from one process-wide string table that
     * defaults to English (`Terminal input`). It reads the table when `open()` builds the field, so setting it per
     * instance keeps every new Terminal, including Caxri Bot's, in the current app language.
     */
    Terminal.strings.promptLabel = translate('terminal.a11y.promptLabel');
    Terminal.strings.tooMuchOutput = translate('terminal.a11y.tooMuchOutput');
    const xterm = new Terminal({
        allowProposedApi: true,
        convertEol: false,
        cursorBlink: true,
        disableStdin: initial.processState !== 'running' || initial.longPastePending,
        fontFamily: initial.fontFamily,
        fontSize: initial.fontSize,
        /**
         * FitAddon reads this option when calculating columns. Keeping it aligned with the styled scrollbar width
         * prevents the grid from reserving xterm's 14px default while the visible scrollbar occupies only 8px.
         */
        scrollbar: { width: 8 },
        scrollback: initial.scrollback,
        theme: xtermThemeWithoutOverviewRulerBorder(initial.terminalTheme),
        /**
         * Lets apps opt into the kitty keyboard protocol, as Ghostty and kitty do, so a TUI can tell `Cmd+C` apart from
         * `Ctrl+C` (Codex copies its own transcript selection on `Cmd+C`). Only apps that push protocol flags change
         * encoding; `terminalCommandKeyOwner` keeps Caxri's Command shortcuts out of it.
         *
         * @see https://sw.kovidgoyal.net/kitty/keyboard-protocol/
         */
        vtExtensions: { kittyKeyboard: true },
        wordSeparator: initial.wordSeparators,
    });
    const fit = new FitAddon();
    const unicode11 = new Unicode11Addon();
    const osc52Clipboard = new ControlledOsc52Clipboard({
        enabled: () => latest().osc52ClipboardWrite,
        onBlocked: (reason) => pushToast('info', translate(OSC52_BLOCK_MESSAGES[reason])),
        onWriteFailure: (error) => {
            onError(translate('terminal.osc52.writeFailed'));
            reportTerminalOsc52ClipboardWriteFailure(error, container, latest().terminalId);
        },
        writeClipboard: (text) => writeClipboardText(text),
    });
    const clipboard = new ClipboardAddon(osc52Clipboard, osc52Clipboard);
    const progress = new ProgressAddon();
    xterm.loadAddon(fit);
    xterm.loadAddon(search);
    xterm.loadAddon(clipboard);
    xterm.loadAddon(progress);
    xterm.loadAddon(unicode11);
    xterm.unicode.activeVersion = '11';
    xterm.open(container);
    settleXtermCreate();
    return { fit, progress, xterm };
}

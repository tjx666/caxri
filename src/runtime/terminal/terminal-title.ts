import { throttle } from 'es-toolkit';

import type { RuntimeEvent } from '../../shared/ipc/events';
import { normalizeTerminalTitle } from '../../shared/terminal-title';
import type { TerminalTitleObserver } from './screen';

/**
 * The narrow persistence surface a title listener needs, kept to one method so the listener stays testable without a
 * database.
 */
interface TerminalTitleStore {
    setTerminalPtyTitle: (id: string, title: string) => boolean;
}

/**
 * Minimum gap between two persisted title updates for one Terminal. Shells rewrite the title on every prompt and some
 * programs animate it (progress reported in the title bar is a common trick), so the raw signal is far too chatty for a
 * durable write plus a Renderer broadcast.
 */
export const TERMINAL_TITLE_THROTTLE_MS = 250;

/**
 * Persists a PTY-reported title and republishes the Terminal record, which is how a tab label learns what a Shell or
 * Agent CLI is actually doing — the same OSC 0/2 signal every terminal emulator has used since xterm.
 *
 * `setTerminalPtyTitle` reports whether anything changed, so the prompt-by-prompt repeat of an unchanged title costs
 * one comparison and no broadcast. Leading-edge delivery keeps a Terminal's first title instant; the trailing edge
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
            if (!database.setTerminalPtyTitle(terminalId, title)) return;
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

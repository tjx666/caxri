import type { ServerEvent, TerminalRecord } from '@caxri/protocol';
import { normalizeTerminalTitle } from '@caxri/protocol';
import { throttle } from 'es-toolkit';

interface TerminalTitleObserver {
    (title: string): void;
    cancel(): void;
}

/**
 * The narrow persistence surface a title listener needs, kept to one method so the listener stays testable without a
 * database.
 */
interface TerminalTitleStore {
    getTerminal: (id: string) => Pick<TerminalRecord, 'provider'> | undefined;
    setTerminalPtyTitle: (id: string, title: string) => boolean;
}

/**
 * Minimum gap between two persisted title updates for one Terminal. Shells rewrite the title on every prompt and some
 * programs animate it (progress reported in the title bar is a common trick), so the raw signal is far too chatty for a
 * durable write plus a Renderer broadcast.
 */
export const TERMINAL_TITLE_THROTTLE_MS = 250;

/**
 * Persists a Shell PTY-reported title and republishes the Terminal record, which is how its tab label learns what the
 * Shell is actually doing: the same OSC 0/2 signal every terminal emulator has used since xterm. Once the durable
 * record binds an Agent provider, conversation metadata owns the semantic title and the OSC signal has no consumer.
 *
 * `setTerminalPtyTitle` reports whether anything changed, so the prompt-by-prompt repeat of an unchanged title costs
 * one comparison and no broadcast. Leading-edge delivery keeps a Terminal's first title instant; the trailing edge
 * guarantees the last title of a burst is the one that sticks. The screen that owns this observer cancels the pending
 * trailing delivery when it is disposed: see `TerminalTitleObserver`.
 */
export function createTerminalTitleListener(
    terminalId: string,
    database: TerminalTitleStore,
    emit: (event: ServerEvent) => void,
    throttleMs = TERMINAL_TITLE_THROTTLE_MS,
): TerminalTitleObserver {
    const publish = throttle(
        (title: string) => {
            const terminal = database.getTerminal(terminalId);
            if (!terminal || terminal.provider) return;
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

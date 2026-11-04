import type { TerminalManager } from './manager';

/**
 * Pastes `text` into an Agent PTY, then presses Enter once the paste is acknowledged. Claude Code reads input arriving
 * in one chunk as a paste, so an Enter inside that chunk only adds a line to the draft and the text is never sent. A
 * bracketed paste followed by its own Enter submits on every provider, as a Composer submission does
 * (`submitAgentText`). Both writes keep `origin: 'delegation'`, so neither bumps the input epoch a later write's own
 * draft fence reads. `launchId` pins both to one exact launch.
 */
export function didPasteAndSubmitAgentText(
    terminals: Pick<TerminalManager, 'writeAgentExact'>,
    terminalId: string,
    text: string,
    launchId: string,
    onDelivered?: (wasAccepted: boolean) => void,
): boolean {
    return terminals.writeAgentExact(
        terminalId,
        `\u{1B}[200~${text}\u{1B}[201~`,
        launchId,
        'delegation',
        (wasPasted) => {
            if (!wasPasted) {
                onDelivered?.(false);
                return;
            }
            // A rejected admission never calls back, so the text is reported unconfirmed here.
            if (!terminals.writeAgentExact(terminalId, '\r', launchId, 'delegation', onDelivered))
                onDelivered?.(false);
        },
    );
}

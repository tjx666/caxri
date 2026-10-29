import type { SessionStatusTerminal } from './session-status';
import { sessionStatus } from './session-status';

/**
 * The one muted line the Session hover card adds when the row's status glyph says something.
 *
 * The row collapses its status glyph while the pointer is over it (Pin and Archive take the right edge), so the card
 * restates what the glyph said in the same short words as the glyph's accessible name (`Working`, `Unread, finished`,
 * `Detached`). A settled Session returns `undefined` and keeps the two-line card.
 */
export function sessionCardStatusLine(
    session: Parameters<typeof sessionStatus>[0],
    terminal?: SessionStatusTerminal,
): string | undefined {
    const status = sessionStatus(session, terminal);
    if (status.kind === 'default') return undefined;
    // The wait's label alone (`Waiting for limit reset`) leaves out the one thing the card is for: when it continues.
    return status.kind === 'usageWait' ? status.ariaDescription : status.ariaLabel;
}

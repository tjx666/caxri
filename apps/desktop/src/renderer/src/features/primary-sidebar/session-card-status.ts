import type { Translate } from '../../i18n';
import type { SessionStatusTerminal } from './session-status';
import { sessionStatus } from './session-status';

/**
 * The one muted line the Session hover card adds when the row's status glyph says something.
 *
 * The row collapses its status glyph while the pointer is over it (Pin and Archive take the right edge), so the card
 * restates what the glyph said in the same short words as the glyph's accessible name (`Working`, `Unread, finished`,
 * `Detached`). A settled Session returns `undefined` and keeps the two-line card. A nested Session whose delegation
 * failed passes `delegationFailed`, so the card says `Delegation failed` for the red X the row collapses on hover.
 */
export function sessionCardStatusLine(
    session: Parameters<typeof sessionStatus>[0],
    terminal: SessionStatusTerminal | undefined,
    t: Translate,
    options?: Parameters<typeof sessionStatus>[3],
): string | undefined {
    const status = sessionStatus(session, terminal ?? {}, t, options);
    if (status.kind === 'default') return undefined;
    // The wait's label alone (`Waiting for limit reset`) leaves out the one thing the card is for: when it continues.
    return status.kind === 'usageWait' ? status.ariaDescription : status.ariaLabel;
}

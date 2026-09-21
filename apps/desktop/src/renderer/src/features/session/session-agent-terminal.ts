import type { SessionRecord, TerminalRecord } from '@caxri/protocol';

/**
 * The Terminal whose lifecycle stands for the whole Session in a list row: the Primary Agent when the Session has one,
 * otherwise whichever Terminal comes first. Every surface that renders a Session's status glyph resolves it the same
 * way, so the PrimarySidebar, the Pinned group, and the Activity view can never disagree about which Terminal a row's
 * spinner or detached glyph is describing.
 */
export function sessionAgentTerminal(
    session: SessionRecord,
    terminals: readonly TerminalRecord[],
): TerminalRecord | undefined {
    const sessionTerminals = terminals.filter((item) => item.sessionId === session.id);
    return (
        sessionTerminals.find((item) => item.id === session.primaryAgentTerminalId) ??
        sessionTerminals[0]
    );
}

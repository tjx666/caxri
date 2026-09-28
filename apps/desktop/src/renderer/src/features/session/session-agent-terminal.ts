import type { SessionRecord, TerminalRecord } from '@caxri/protocol';

/**
 * The one rule both lookups below apply to a Session's own Terminals, in record order: the Primary Agent when the
 * Session has one, otherwise the first. Kept private so the single and the batch lookup cannot drift apart.
 */
function pickSessionAgentTerminal(
    session: SessionRecord,
    sessionTerminals: readonly TerminalRecord[],
): TerminalRecord | undefined {
    return (
        sessionTerminals.find((item) => item.id === session.primaryAgentTerminalId) ??
        sessionTerminals[0]
    );
}

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
    return pickSessionAgentTerminal(
        session,
        terminals.filter((item) => item.sessionId === session.id),
    );
}

/**
 * Every Session's Terminals, grouped in one pass and kept in record order.
 */
export type SessionTerminalIndex = ReadonlyMap<string, readonly TerminalRecord[]>;

/**
 * Builds the index a projection over every Session reads instead of calling {@link sessionAgentTerminal} per Session:
 * that call filters the whole Terminal list each time, so a full projection costs Sessions × Terminals and allocates
 * one array per Session. Grouping once makes the same projection linear (issue caxri#1111).
 */
export function sessionTerminalIndex(terminals: readonly TerminalRecord[]): SessionTerminalIndex {
    return Map.groupBy(terminals, (terminal) => terminal.sessionId);
}

/**
 * {@link sessionAgentTerminal} against a prebuilt {@link sessionTerminalIndex}. Same rule, same result: a Primary Agent
 * id that points at another Session's Terminal is not in this Session's group, so it cannot resolve here either.
 */
export function indexedSessionAgentTerminal(
    session: SessionRecord,
    index: SessionTerminalIndex,
): TerminalRecord | undefined {
    return pickSessionAgentTerminal(session, index.get(session.id) ?? []);
}

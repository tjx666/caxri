/**
 * Content-free `pty.attach` log evidence so a "frozen Terminal" report can be traced end to end: after a
 * `server_connection.reconnected` outage these lines prove whether the Renderer actually re-fetched the authoritative
 * screen for each pane, and their absence localizes the fault to the Renderer resync trigger. Only sizes are logged:
 * never snapshot bytes.
 */
export function attachLogFields(options: {
    payloadBytes: number;
    size?: { cols: number; rows: number };
    source: 'live' | 'persisted';
    terminalId: string;
    wasAttached: boolean;
}): Record<string, boolean | number | string> {
    return {
        terminalId: options.terminalId,
        source: options.source,
        wasAttached: options.wasAttached,
        payloadBytes: options.payloadBytes,
        ...(options.size !== undefined && { cols: options.size.cols, rows: options.size.rows }),
    };
}

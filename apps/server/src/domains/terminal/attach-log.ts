import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

/**
 * Records one view attach. Content-free evidence localizes reconnect failures without recording Terminal output or
 * snapshots.
 */
export function logTerminalAttach(
    logger: StructuredLogger,
    attach: {
        terminalId: string;
        size: { cols: number; rows: number } | undefined;
        wasAttached: boolean;
        source: 'live' | 'persisted';
        payloadBytes: number;
    },
): void {
    const { size, ...fields } = attach;
    logger.write('info', logEventCatalog.pty.attach, {
        fields: { ...fields, ...(size !== undefined && { cols: size.cols, rows: size.rows }) },
    });
}

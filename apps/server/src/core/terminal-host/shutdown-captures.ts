import type { TerminalSnapshot } from '@caxri/protocol';

import type { TerminalShutdownFailure } from '../../terminal-host/protocol';

const SHUTDOWN_SNAPSHOT_OMITTED_MESSAGE = 'Terminal Host shutdown omitted the final snapshot';

/**
 * Reconciles `host.shutdown`'s per-Terminal snapshots and failures back onto every Terminal that was live when shutdown
 * began. A specific per-terminal failure reason (see `TerminalHostRuntime.captureShutdown`) is more actionable than the
 * generic fallback, which now only applies when the Host never replied at all (e.g. it timed out or crashed before
 * producing any result).
 */
export function buildShutdownCaptures(
    liveIds: readonly string[],
    snapshots: readonly TerminalSnapshot[],
    failures: readonly TerminalShutdownFailure[],
): Array<{ terminalId: string; capture: Promise<TerminalSnapshot> }> {
    const snapshotByTerminal = new Map(
        snapshots.map((snapshot) => [snapshot.terminalId, snapshot]),
    );
    const failureByTerminal = new Map(failures.map((failure) => [failure.terminalId, failure]));
    return liveIds.map((terminalId) => ({
        terminalId,
        capture: snapshotByTerminal.has(terminalId)
            ? Promise.resolve(snapshotByTerminal.get(terminalId)!)
            : Promise.reject(
                  new Error(
                      failureByTerminal.get(terminalId)?.error ?? SHUTDOWN_SNAPSHOT_OMITTED_MESSAGE,
                  ),
              ),
    }));
}

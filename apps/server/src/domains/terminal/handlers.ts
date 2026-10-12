import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import { applyTerminalResourceOverride } from './e2e-resource-override';
import type { TerminalManager } from './manager';
import type { TerminalResourceMonitor } from './resource-monitor';
import type { TerminalSuspensionService } from './suspension';

interface TerminalHandlerOptions {
    /**
     * Live Chats, whose provider processes `terminals` does not see. `terminal.runningCount` feeds the window-close and
     * deletion confirmations, so a Chat-only Session must not read as idle while its provider keeps running, and the
     * prompt names Terminals and Chats separately so the user can tell a shell from an Agent still working.
     */
    countLiveChats: (sessionId?: string) => number;
    database: Pick<CaxriDatabase, 'getTerminal'>;
    resourceMonitor: Pick<TerminalResourceMonitor, 'processes' | 'readingOverride'>;
    terminals: Pick<
        TerminalManager,
        | 'attach'
        | 'detachAllViews'
        | 'detachView'
        | 'preview'
        | 'resize'
        | 'resources'
        | 'runningCount'
        | 'snapshot'
    >;
    terminalSuspension: Pick<TerminalSuspensionService, 'suspendOnRequest'>;
}

/**
 * The Terminal methods that only view, measure, or park an existing Terminal. They touch no Session state and send no
 * full-state change of their own, so they need none of the lifecycle wiring the create, close, and restart handlers
 * do.
 */
export function createTerminalHandlers({
    countLiveChats,
    database,
    resourceMonitor,
    terminals,
    terminalSuspension,
}: TerminalHandlerOptions): Pick<
    DomainHandlers,
    | 'terminal.attach'
    | 'terminal.detach'
    | 'terminal.detachAll'
    | 'terminal.preview'
    | 'terminal.processes'
    | 'terminal.resize'
    | 'terminal.resources'
    | 'terminal.runningCount'
    | 'terminal.snapshot'
    | 'terminal.suspend'
> {
    return {
        'terminal.resize': ({ terminalId, cols, rows }) => {
            terminals.resize(terminalId, cols, rows);
            return null;
        },
        'terminal.attach': ({ cols, rows, terminalId }) =>
            terminals.attach(
                terminalId,
                cols === undefined || rows === undefined ? undefined : { cols, rows },
            ),
        'terminal.detach': ({ terminalId }) => {
            terminals.detachView(terminalId);
            return null;
        },
        'terminal.detachAll': () => {
            terminals.detachAllViews();
            return null;
        },
        'terminal.snapshot': ({ terminalId }) => terminals.snapshot(terminalId),
        'terminal.preview': ({ terminalId }) => terminals.preview(terminalId),
        'terminal.runningCount': ({ sessionId }) => ({
            terminals: terminals.runningCount(sessionId),
            chats: countLiveChats(sessionId),
        }),
        /**
         * Applies the monitor's E2E-only reading injection so the chip and the resource alert see one value; a no-op
         * outside an explicit E2E launch.
         */
        'terminal.resources': async ({ terminalId }) =>
            applyTerminalResourceOverride(
                await terminals.resources(terminalId),
                await resourceMonitor.readingOverride(terminalId),
            ),
        'terminal.processes': () => ({ terminals: resourceMonitor.processes() }),
        /**
         * Suspends rather than closes, so the Session and its Agent conversation stay resumable. `suspended: false`
         * means the Terminal was not running anything to stop.
         */
        'terminal.suspend': async ({ terminalId }) => {
            if (!database.getTerminal(terminalId))
                throw new CaxriError('NOT_FOUND', 'Terminal not found');
            return { suspended: await terminalSuspension.suspendOnRequest(terminalId) };
        },
    };
}

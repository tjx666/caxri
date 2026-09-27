import { useEffect, useState } from 'react';

import { debounce } from 'es-toolkit';

import { caxri } from '../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../queries/client';
import { describeFailure } from '../../stores/toasts';
import { refreshWorkbench, useWorkbenchStore } from '../../stores/workbench';
import { ensureAgentCommander, useAgentCommanderStore } from './commander-client';
import { commanderEventEffect } from './commander-events';

/**
 * Long enough to fold one burst of `state.changed` (a delegation touches a Session, its Terminal, and its Project) into
 * one board read, short enough that the board still feels live.
 */
const BOARD_REFRESH_DEBOUNCE_MS = 500;

export type AgentCommanderStatus =
    { kind: 'error'; message: string } | { kind: 'loading' } | { kind: 'ready' };

const LOADING: AgentCommanderStatus = { kind: 'loading' };
const READY: AgentCommanderStatus = { kind: 'ready' };

/**
 * A snapshot read an event asked for before the first snapshot landed. It cannot run yet — this window has no Workbench
 * store to replace — and it cannot be dropped, because `commander.ensure` may have read its rows before the change.
 */
const deferredSnapshot = { isPending: false };

function refreshCommanderSnapshot(): void {
    if (!useWorkbenchStore.getState().bootstrap) {
        deferredSnapshot.isPending = true;
        return;
    }
    // Fire-and-forget: refreshWorkbench() reports its own Server request failures.
    // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
    void refreshWorkbench();
}

function flushDeferredSnapshot(): void {
    if (!deferredSnapshot.isPending) return;
    deferredSnapshot.isPending = false;
    refreshCommanderSnapshot();
}

/**
 * The Agent Commander window's whole lifecycle: create or reuse the Commander, then keep its scoped snapshot and the
 * board current from Server events. This is the window's only event subscription; it never calls
 * `subscribeWorkbenchEvents`, whose UI commands and Workbench-wide reads belong to the Workbench window.
 */
export function useAgentCommander(): { retry: () => void; status: AgentCommanderStatus } {
    const [status, setStatus] = useState<AgentCommanderStatus>(LOADING);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        const refetchBoard = debounce(() => {
            // Fire-and-forget: the board query surfaces its own failure in the board.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void queryClient.invalidateQueries({
                queryKey: caxriQueryKey('commander.board', undefined),
            });
        }, BOARD_REFRESH_DEBOUNCE_MS);
        const unsubscribe = caxri.onEvent((event) => {
            const effect = commanderEventEffect(event, useAgentCommanderStore.getState().identity);
            if (effect.reattach)
                useWorkbenchStore.setState((current) => ({
                    attachEpoch: current.attachEpoch + 1,
                }));
            if (effect.snapshot) refreshCommanderSnapshot();
            if (effect.board) refetchBoard();
        });
        return () => {
            unsubscribe();
            refetchBoard.cancel();
        };
    }, []);

    useEffect(() => {
        const run = { isCurrent: true };
        const start = async (): Promise<void> => {
            try {
                await ensureAgentCommander();
            } catch (error) {
                if (run.isCurrent)
                    setStatus({
                        kind: 'error',
                        message: describeFailure(error, 'Unable to start Agent Commander'),
                    });
                return;
            }
            if (!run.isCurrent) return;
            setStatus(READY);
            flushDeferredSnapshot();
        };
        // Fire-and-forget: start() turns its own failure into the error state.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void start();
        return () => {
            run.isCurrent = false;
        };
    }, [attempt]);

    return {
        retry: () => {
            setStatus(LOADING);
            setAttempt((current) => current + 1);
        },
        status,
    };
}

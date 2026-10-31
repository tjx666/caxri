import { useEffect, useRef, useState } from 'react';

import type { BotAgent } from '@caxri/protocol';
import { debounce } from 'es-toolkit';

import { caxri } from '../../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../../queries/client';
import { syncWindowFullScreen } from '../../../stores/window-full-screen';
import { refreshWorkbench, useWorkbenchStore } from '../../../stores/workbench';
import {
    ensureCaxriBot,
    readCaxriBotStartPrompt,
    refreshBotBoardPullRequests,
    startCaxriBot,
    useCaxriBotStore,
} from '../bot-client';
import { requestBotPalette } from '../bot-dialogs-store';
import { botEventEffect } from '../bot-events';
import { invalidateBotInbox } from '../bot-inbox-commands';
import { revealBotInbox } from '../bot-inbox-store';

/**
 * Long enough to fold one burst of `state.changed` (a delegation touches a Session, its Terminal, and its Project) into
 * one board read, short enough that the board still feels live.
 */
const BOARD_REFRESH_DEBOUNCE_MS = 500;

export type CaxriBotStatus =
    | { kind: 'error'; error: unknown }
    | { kind: 'loading' }
    /**
     * Caxri Bot has never been created: the window asks before the first start, with this Agent preselected.
     */
    | { kind: 'prompt'; agent: BotAgent }
    | { kind: 'ready' };

const LOADING: CaxriBotStatus = { kind: 'loading' };
const READY: CaxriBotStatus = { kind: 'ready' };

/**
 * A snapshot read an event asked for before the first snapshot landed. It cannot run yet: this window has no Workbench
 * store to replace, and it cannot be dropped, because `bot.ensure` may have read its rows before the change.
 */
const deferredSnapshot = { isPending: false };

function refreshBotSnapshot(): void {
    if (!useWorkbenchStore.getState().bootstrap) {
        deferredSnapshot.isPending = true;
        return;
    }
    // Fire-and-forget: refreshWorkbench() reports its own Server request failures.
    void refreshWorkbench();
}

function flushDeferredSnapshot(): void {
    if (!deferredSnapshot.isPending) return;
    deferredSnapshot.isPending = false;
    refreshBotSnapshot();
}

/**
 * The Caxri Bot window's whole lifecycle: create or reuse Caxri Bot, then keep its scoped snapshot and the board
 * current from Server events. This is the window's only event subscription; it never calls `subscribeWorkbenchEvents`,
 * whose UI commands and Workbench-wide reads belong to the Workbench window.
 */
export function useCaxriBot(): {
    retry: () => void;
    start: (agent: BotAgent) => void;
    status: CaxriBotStatus;
} {
    const [status, setStatus] = useState<CaxriBotStatus>(LOADING);
    const [attempt, setAttempt] = useState(0);
    /**
     * The Agent the user chose in the start prompt, consumed by the next start attempt. Later attempts (a Server
     * restart, a retry) find Caxri Bot's rows and resume it through `bot.ensure` like any reopen.
     */
    const chosenStart = useRef<{ agent: BotAgent; storedAgent: BotAgent } | undefined>(undefined);

    useEffect(() => {
        const refetchBoard = debounce(() => {
            // Fire-and-forget: the board query surfaces its own failure in the board.
            void queryClient.invalidateQueries({
                queryKey: caxriQueryKey('bot.board', undefined),
            });
        }, BOARD_REFRESH_DEBOUNCE_MS);
        /**
         * Sessions named by pull-request changes inside one debounce window, patched together by one read.
         */
        const pullRequestSessionIds = new Set<string>();
        async function patchPendingPullRequestRows(): Promise<void> {
            const sessionIds = new Set(pullRequestSessionIds);
            pullRequestSessionIds.clear();
            try {
                await refreshBotBoardPullRequests(sessionIds);
            } catch {
                // A failed read leaves those rows as they were until the board's own poll re-reads them; the Server
                // records the failed request, and a toast for a background badge refresh would only be noise.
            }
        }
        const patchPullRequestRows = debounce(() => {
            void patchPendingPullRequestRows();
        }, BOARD_REFRESH_DEBOUNCE_MS);
        const unsubscribe = caxri.onEvent((event) => {
            const effect = botEventEffect(event, useCaxriBotStore.getState().identity);
            if (effect.reattach)
                useWorkbenchStore.setState((current) => ({
                    attachEpoch: current.attachEpoch + 1,
                }));
            if (effect.isFullScreen !== undefined)
                useWorkbenchStore.setState({ isFullScreen: effect.isFullScreen });
            if (effect.snapshot) refreshBotSnapshot();
            if (effect.board) refetchBoard();
            // Fire-and-forget: the Inbox query surfaces its own failure in the Inbox column.
            if (effect.inbox) void invalidateBotInbox();
            if (effect.revealInbox) revealBotInbox();
            if (effect.openPalette) requestBotPalette();
            if (effect.pullRequestSessionIds.length > 0) {
                for (const sessionId of effect.pullRequestSessionIds)
                    pullRequestSessionIds.add(sessionId);
                patchPullRequestRows();
            }
            // Re-runs the start effect without its loading state: the pane keeps its screen while the Server resumes it.
            if (effect.ensure) setAttempt((current) => current + 1);
        });
        // Fire-and-forget: syncWindowFullScreen() swallows its own request failure.
        void syncWindowFullScreen();
        return () => {
            unsubscribe();
            refetchBoard.cancel();
            patchPullRequestRows.cancel();
        };
    }, []);

    useEffect(() => {
        const run = { isCurrent: true };
        const choice = chosenStart.current;
        chosenStart.current = undefined;
        const start = async (): Promise<void> => {
            try {
                if (choice) await startCaxriBot(choice.agent, choice.storedAgent);
                else {
                    const prompt = await readCaxriBotStartPrompt();
                    if (prompt) {
                        if (run.isCurrent) setStatus({ kind: 'prompt', agent: prompt.agent });
                        return;
                    }
                    await ensureCaxriBot();
                }
            } catch (error) {
                if (run.isCurrent) setStatus({ kind: 'error', error });
                return;
            }
            if (!run.isCurrent) return;
            setStatus(READY);
            flushDeferredSnapshot();
        };
        // Fire-and-forget: start() turns its own failure into the error state.
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
        start: (agent) => {
            if (status.kind !== 'prompt') return;
            chosenStart.current = { agent, storedAgent: status.agent };
            setStatus(LOADING);
            setAttempt((current) => current + 1);
        },
        status,
    };
}

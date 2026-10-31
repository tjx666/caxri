import type { BootstrapState, BotAgent, BotBoard, BotIdentity, BotSnapshot } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { createStore } from '../../lib/store';
import { caxriQueryKey, fetchCaxriQuery, queryClient } from '../../queries/client';
import { useWorkbenchStore } from '../../stores/workbench';
import { patchBotBoardPullRequests } from './bot-board';

interface CaxriBotState {
    /**
     * Caxri Bot's system Project, Session, and Terminal, known once `bot.ensure` resolves.
     */
    identity?: BotIdentity;
    workspacePath?: string;
}

export const useCaxriBotStore = createStore<CaxriBotState>('caxri-bot', () => ({}));

function adoptSnapshot(snapshot: BotSnapshot): void {
    useCaxriBotStore.setState({
        identity: snapshot.identity,
        workspacePath: snapshot.workspacePath,
    });
}

function adoptStartedSnapshot(snapshot: BotSnapshot): void {
    adoptSnapshot(snapshot);
    useWorkbenchStore.setState({ bootstrap: snapshot.workbench });
}

const ensureRequest = { inFlight: undefined as Promise<void> | undefined };

async function runEnsure(): Promise<void> {
    try {
        adoptStartedSnapshot(await caxri.request('bot.ensure'));
    } finally {
        ensureRequest.inFlight = undefined;
    }
}

/**
 * Creates Caxri Bot on first use and seeds the Workbench store with its scoped snapshot. The Workbench store is what
 * the ordinary Terminal pane reads, so this window reuses that pane unchanged. Main learns Caxri Bot's Terminal from
 * this reply before it admits any `terminal.*` request for it, which is why the pane mounts only afterwards.
 *
 * Single-flight: `bot.ensure` launches Caxri Bot's Terminal when it creates one, so React StrictMode's double mount
 * must share one request instead of racing two creations.
 */
export function ensureCaxriBot(): Promise<void> {
    ensureRequest.inFlight ??= runEnsure();
    return ensureRequest.inFlight;
}

/**
 * Whether opening this window should first ask the user to start Caxri Bot, and with which Agent preselected. Caxri Bot
 * keeps running after its window closes and runs its Agents with full access, so the first start is the user's explicit
 * choice rather than a side effect of opening the window. Once its rows exist (it ran before, even if stopped since),
 * reopening resumes it as before. Reads only: neither request creates or launches anything.
 */
export async function readCaxriBotStartPrompt(): Promise<{ agent: BotAgent } | undefined> {
    if (await caxri.request('bot.snapshot')) return undefined;
    const data = await caxri.request('bot.data');
    return { agent: data.conversation.agent };
}

/**
 * Starts Caxri Bot from the start prompt. A different Agent goes through `bot.switchAgent`, which stores the choice
 * and, with no Caxri Bot yet, creates it on that Agent in the same request.
 */
export async function startCaxriBot(agent: BotAgent, storedAgent: BotAgent): Promise<void> {
    if (agent === storedAgent) return ensureCaxriBot();
    adoptStartedSnapshot(await caxri.request('bot.switchAgent', { agent }));
}

/**
 * The Workbench store's snapshot source in this window (see `configureWorkbenchSnapshotSource`). Every refresh, whether
 * this window's event bridge asked for it or a shared Terminal command did, reads Caxri Bot-scoped snapshot, which also
 * keeps Main's record of Caxri Bot's Terminal current.
 */
export async function readCaxriBotWorkbench(): Promise<BootstrapState> {
    const snapshot = await caxri.request('bot.snapshot');
    if (!snapshot) throw new Error(translate('caxriBot.terminal.noLongerSetUp'));
    adoptSnapshot(snapshot);
    return snapshot.workbench;
}

/**
 * Patches the board rows of Sessions whose pull request changed, from one fresh `session.pullRequests` read, instead of
 * refetching the whole board (issue caxri#1411).
 *
 * The Workbench window keeps that snapshot fresh through `useRuntimeQueryInvalidation`, but this window never mounts it
 * (`useCaxriBot` is its only event subscription), so there is no refreshed copy here to reuse and it reads its own.
 * `staleTime: 0` because the event already says the previous answer is out of date. The Server answers from the sweep
 * that emitted the event, so this read does not start another GitHub lookup.
 *
 * A board that has not loaded yet has no rows to patch, and its first read may have been answered before the sweep and
 * still be on its way here, so it is asked to read again instead; that only happens before the first board lands. Once
 * the board is loaded there is no race with its poll: one that started before the sweep finished was answered long
 * before this debounced patch runs, and one that starts after it reads the same new snapshot.
 */
export async function refreshBotBoardPullRequests(sessionIds: ReadonlySet<string>): Promise<void> {
    if (sessionIds.size === 0) return;
    const boardKey = caxriQueryKey('bot.board', undefined);
    if (!queryClient.getQueryData(boardKey)) {
        await queryClient.invalidateQueries({ queryKey: boardKey });
        return;
    }
    const snapshot = await fetchCaxriQuery('session.pullRequests', undefined, { staleTime: 0 });
    queryClient.setQueryData<BotBoard>(
        boardKey,
        (board) => board && patchBotBoardPullRequests(board, snapshot, sessionIds),
    );
}

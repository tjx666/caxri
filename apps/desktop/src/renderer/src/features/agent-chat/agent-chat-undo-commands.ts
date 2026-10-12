import type { AgentChatEditedFile } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { parentDirectoryPath } from '../../lib/file-path';
import { createStore } from '../../lib/store';
import { pushToast, tryCommand } from '../../stores/toasts';
import type { AgentChatRedoFile, AgentChatUndoStep } from './agent-chat-undo';
import {
    agentChatRedoFailureMessage,
    agentChatRedoSuccessMessage,
    agentChatUndoFailureMessage,
    agentChatUndoSuccessMessage,
    planAgentChatFileRedo,
    planAgentChatFileUndo,
} from './agent-chat-undo';

type AgentChatUndoStatus = 'undoing' | 'undone';

interface AgentChatUndoState {
    /**
     * Turns being undone or already undone, keyed by {@link agentChatUndoKey}. Kept outside the card so the state
     * survives the transcript remounting it on a fold toggle or a Chat switch.
     */
    turns: Readonly<Partial<Record<string, AgentChatUndoStatus>>>;
    /**
     * What each completed Undo replaced, keyed like `turns`, so the success toast's Redo can put it back. File bodies
     * stay here rather than in the toast action, which must remain plain identity data. Memory only, like `turns`.
     */
    redo: Readonly<Partial<Record<string, readonly AgentChatRedoFile[]>>>;
}

export const useAgentChatUndoStore = createStore<AgentChatUndoState>('agentChatUndo', () => ({
    turns: {},
    redo: {},
}));

export const agentChatUndoKey = (sessionId: string, turnId: string): string =>
    `${sessionId}:${turnId}`;

function setStatus(key: string, status: AgentChatUndoStatus | undefined): void {
    useAgentChatUndoStore.setState(({ turns }) => {
        const next = { ...turns };
        if (status) next[key] = status;
        else delete next[key];
        return { turns: next };
    });
}

function setRedo(key: string, files: readonly AgentChatRedoFile[] | undefined): void {
    useAgentChatUndoStore.setState(({ redo }) => {
        const next = { ...redo };
        if (files) next[key] = files;
        else delete next[key];
        return { redo: next };
    });
}

/**
 * The file's content now, or `undefined` when it does not exist.
 */
async function readCurrent(sessionId: string, path: string): Promise<string | undefined> {
    try {
        return (await caxri.request('files.read', { sessionId, path })).content;
    } catch (error) {
        if (isCaxriError(error) && error.code === 'NOT_FOUND') return undefined;
        throw error;
    }
}

/**
 * Applies one planned step; `false` when the user canceled the Trash confirmation.
 */
async function didApplyStep(sessionId: string, step: AgentChatUndoStep): Promise<boolean> {
    switch (step.action) {
        case 'none': {
            return true;
        }
        case 'trash': {
            const result = await caxri.request('files.trash', { sessionId, path: step.path });
            return !('canceled' in result);
        }
        case 'restore': {
            await caxri.request('files.create', {
                operationId: crypto.randomUUID(),
                sessionId,
                directory: parentDirectoryPath(step.path),
                name: pathBasename(step.path),
                kind: 'file',
            });
            await caxri.request('files.write', {
                sessionId,
                path: step.path,
                content: step.content,
            });
            return true;
        }
        case 'write': {
            await caxri.request('files.write', {
                sessionId,
                path: step.path,
                content: step.content,
            });
            return true;
        }
    }
}

/**
 * Applies steps one after another, stopping at the first the user canceled or that failed. Sequential on purpose: each
 * Trash waits on its own native confirmation, and a cancel stops the rest. Reports how many were applied, so a stop
 * after the first can say the Undo was partial.
 */
async function applySteps(
    sessionId: string,
    steps: readonly AgentChatUndoStep[],
    count = 0,
): Promise<{ count: number; error?: unknown }> {
    const step = steps.at(count);
    if (!step) return { count };
    try {
        if (!(await didApplyStep(sessionId, step))) return { count };
    } catch (error) {
        return { count, error };
    }
    // eslint-disable-next-line unicorn/no-useless-recursion -- React Doctor blocks the sequential `await` a loop would need
    return applySteps(sessionId, steps, count + 1);
}

/**
 * Applies every step, Trash first: files go to the Trash (each behind the native confirmation) before any rewrite, so
 * canceling that dialog leaves the rest untouched. A stop after the first warns that the operation was partial; the
 * caller rethrows `error`.
 */
async function applyAll(
    sessionId: string,
    steps: readonly AgentChatUndoStep[],
    partialMessage: string,
): Promise<{ isComplete: boolean; count: number; error?: unknown }> {
    const ordered = [
        ...steps.filter((step) => step.action === 'trash'),
        ...steps.filter((step) => step.action !== 'trash'),
    ];
    const applied = await applySteps(sessionId, ordered);
    if (applied.count > 0 && (applied.count < ordered.length || 'error' in applied))
        pushToast('warning', partialMessage);
    return { ...applied, isComplete: !('error' in applied) && applied.count === ordered.length };
}

/**
 * Undoes every file change a finished turn made, all or nothing: each file is read and its undo planned first, and if
 * any file no longer holds what the turn left there, nothing is written and a toast names it. Paths go through Server
 * Core's Session path authorization like any Editor save. A complete Undo says so in a success toast and marks the turn
 * `undone`, so its card stops offering Undo for the rest of this window's life; what it replaced is kept for Redo. When
 * every file already holds its content from before the turn (an Undo taken before a window reload), nothing is written
 * and the turn is simply marked `undone`.
 */
export async function undoAgentChatTurn({
    sessionId,
    turnId,
    files,
    displayPath,
}: {
    sessionId: string;
    turnId: string;
    files: readonly AgentChatEditedFile[];
    displayPath: (path: string) => string;
}): Promise<void> {
    const key = agentChatUndoKey(sessionId, turnId);
    setStatus(key, 'undoing');
    const isUndone = await tryCommand(translate('agentChat.undo.failedTitle'), async () => {
        const planned = await Promise.all(
            files.map(async (file) => {
                const current = await readCurrent(sessionId, file.path);
                return { current, plan: planAgentChatFileUndo(file, current) };
            }),
        );
        const steps: AgentChatUndoStep[] = [];
        const redo: AgentChatRedoFile[] = [];
        for (const { current, plan } of planned) {
            if (!plan.ok) {
                pushToast(
                    'error',
                    agentChatUndoFailureMessage(displayPath(plan.path), plan.reason),
                );
                return false;
            }
            const { step } = plan;
            if (step.action === 'none') continue;
            steps.push(step);
            redo.push({
                path: step.path,
                displayPath: displayPath(step.path),
                before: current,
                after: 'content' in step ? step.content : undefined,
            });
        }
        if (steps.length === 0) return true;
        const applied = await applyAll(sessionId, steps, translate('agentChat.undo.partial'));
        if ('error' in applied) throw applied.error;
        const { isComplete } = applied;
        if (isComplete) {
            setRedo(key, redo);
            pushToast('success', agentChatUndoSuccessMessage(files.length), {
                action: { id: 'agentChat.redoUndo', params: { sessionId, turnId } },
            });
        }
        return isComplete;
    });
    setStatus(key, isUndone === true ? 'undone' : undefined);
}

/**
 * Turns whose Redo is running, so a second click on a toast button cannot start another.
 */
const redoing = new Set<string>();

/**
 * Why a toast's Redo can no longer run: the Undo it would take back was already redone, or this window reloaded and
 * lost what the Undo replaced.
 */
export function agentChatRedoUnavailableReason({
    sessionId,
    turnId,
}: {
    sessionId: string;
    turnId: string;
}): string | undefined {
    const key = agentChatUndoKey(sessionId, turnId);
    const state = useAgentChatUndoStore.getState();
    return state.turns[key] === 'undone' && state.redo[key] !== undefined && !redoing.has(key)
        ? undefined
        : translate('agentChat.redo.unavailable');
}

/**
 * Takes back a completed Undo: puts back what it replaced in every file, all or nothing like Undo itself. A file that
 * changed after the Undo refuses the whole Redo with a toast naming it. Once any file was written the turn offers Undo
 * again; its planner treats files still holding their pre-turn content as already undone.
 */
export async function redoAgentChatTurn({
    sessionId,
    turnId,
}: {
    sessionId: string;
    turnId: string;
}): Promise<void> {
    const key = agentChatUndoKey(sessionId, turnId);
    const files = useAgentChatUndoStore.getState().redo[key];
    if (!files || redoing.has(key)) return;
    redoing.add(key);
    /**
     * Whether any file was written, kept outside the command because a write failure after the first file throws.
     */
    const progress = { didWrite: false };
    const isRedone = await tryCommand(translate('agentChat.redo.failedTitle'), async () => {
        const plans = await Promise.all(
            files.map(async (file) =>
                planAgentChatFileRedo(file, await readCurrent(sessionId, file.path)),
            ),
        );
        const steps: AgentChatUndoStep[] = [];
        for (const [index, plan] of plans.entries()) {
            if (!plan.ok) {
                pushToast(
                    'error',
                    agentChatRedoFailureMessage(
                        files.at(index)?.displayPath ?? plan.path,
                        plan.reason,
                    ),
                );
                return false;
            }
            steps.push(plan.step);
        }
        const applied = await applyAll(sessionId, steps, translate('agentChat.redo.partial'));
        progress.didWrite = applied.count > 0;
        if ('error' in applied) throw applied.error;
        if (applied.isComplete) pushToast('success', agentChatRedoSuccessMessage(files.length));
        return applied.isComplete;
    });
    redoing.delete(key);
    if (isRedone === true || progress.didWrite) {
        setRedo(key, undefined);
        setStatus(key, undefined);
    }
}

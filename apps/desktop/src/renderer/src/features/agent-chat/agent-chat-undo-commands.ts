import { isCaxriError } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { parentDirectoryPath } from '../../lib/file-path';
import { createStore } from '../../lib/store';
import { pushToast, tryCommand } from '../../stores/toasts';
import type { AgentChatEditedFile } from './agent-chat-turn-artifacts';
import type { AgentChatUndoStep } from './agent-chat-undo';
import {
    agentChatUndoFailureMessage,
    agentChatUndoSuccessMessage,
    planAgentChatFileUndo,
} from './agent-chat-undo';

type AgentChatUndoStatus = 'undoing' | 'undone';

interface AgentChatUndoState {
    /**
     * Turns being undone or already undone, keyed by {@link agentChatUndoKey}. Kept outside the card so the state
     * survives the transcript remounting it on a fold toggle or a Chat switch.
     */
    turns: Readonly<Record<string, AgentChatUndoStatus>>;
}

export const useAgentChatUndoStore = createStore<AgentChatUndoState>('agentChatUndo', () => ({
    turns: {},
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
 * Undoes every file change a finished turn made, all or nothing: each file is read and its undo planned first, and if
 * any file no longer holds what the turn left there, nothing is written and a toast names it. Files the turn created go
 * to the Trash (each behind the native confirmation) before any rewrite, so canceling that dialog leaves the rest
 * untouched. Paths go through Server Core's Session path authorization like any Editor save. A complete Undo says so in
 * a success toast and marks the turn `undone`, so its card stops offering Undo for the rest of this window's life.
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
        const plans = await Promise.all(
            files.map(async (file) =>
                planAgentChatFileUndo(file, await readCurrent(sessionId, file.path)),
            ),
        );
        const steps: AgentChatUndoStep[] = [];
        for (const plan of plans) {
            if (!plan.ok) {
                pushToast(
                    'error',
                    agentChatUndoFailureMessage(displayPath(plan.path), plan.reason),
                );
                return false;
            }
            steps.push(plan.step);
        }
        const ordered = [
            ...steps.filter((step) => step.action === 'trash'),
            ...steps.filter((step) => step.action !== 'trash'),
        ];
        const applied = await applySteps(sessionId, ordered);
        if (applied.count > 0 && (applied.count < ordered.length || 'error' in applied))
            pushToast('warning', translate('agentChat.undo.partial'));
        if ('error' in applied) throw applied.error;
        const isComplete = applied.count === ordered.length;
        if (isComplete) pushToast('success', agentChatUndoSuccessMessage(files.length));
        return isComplete;
    });
    setStatus(key, isUndone === true ? 'undone' : undefined);
}

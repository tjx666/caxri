import { isCaxriError } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import { caxri } from '../../lib/caxri';
import { parentDirectoryPath } from '../../lib/file-path';
import { createStore } from '../../lib/store';
import { pushToast, tryCommand } from '../../stores/toasts';
import type { AgentChatEditedFile } from './agent-chat-turn-artifacts';
import type { AgentChatUndoStep } from './agent-chat-undo';
import { agentChatUndoFailureMessage, planAgentChatFileUndo } from './agent-chat-undo';

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
 * Undoes every file change a finished turn made, all or nothing: each file is read and its undo planned first, and if
 * any file no longer holds what the turn left there, nothing is written and a toast names it. Files the turn created go
 * to the Trash (each behind the native confirmation) before any rewrite, so canceling that dialog leaves the rest
 * untouched. Paths go through Server Core's Session path authorization like any Editor save.
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
    const isUndone = await tryCommand('Unable to undo the Agent changes', async () => {
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
        const warnPartway = (index: number): void => {
            if (index > 0)
                pushToast('warning', 'Undo stopped partway: some files were already restored.');
        };
        for (const [index, step] of ordered.entries()) {
            try {
                // Sequential on purpose: each Trash waits on its own native confirmation, and a cancel stops the rest.
                // eslint-disable-next-line no-await-in-loop -- see above
                if (await didApplyStep(sessionId, step)) continue;
            } catch (error) {
                warnPartway(index);
                throw error;
            }
            warnPartway(index);
            return false;
        }
        return true;
    });
    setStatus(key, isUndone === true ? 'undone' : undefined);
}

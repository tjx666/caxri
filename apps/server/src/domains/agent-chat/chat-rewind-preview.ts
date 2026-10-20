import type { AgentChatItem, AgentChatRewindRefusal, AgentChatSnapshot } from '@caxri/protocol';
import {
    agentChatRewindTarget,
    agentProviderCatalog,
    CaxriError,
    collectAgentChatEditedFiles,
} from '@caxri/protocol';

import { requireChatTerminal } from './chat-launch';
import type { ChatRestorePreview } from './chat-provider';
import type { ChatStateDelivery } from './chat-states';
import type { AgentChatServiceOptions } from './service-options';

/**
 * Why a preview is refused: the same reasons "Restore code to here" gives.
 */
const REFUSALS: Record<AgentChatRewindRefusal, string> = {
    turnRunning: 'Stop the running turn before restoring code',
    notTurnStart:
        'This message joined a turn that was already running, so its code cannot be restored on its own',
    unknownMessage: 'This message is no longer in the conversation',
};

/**
 * Most files a preview lists; the rest are counted in `totalFiles`. It bounds the response, not the revert.
 */
const MAX_PREVIEW_FILES = 200;

/**
 * What "Restore code to here" would revert, for the confirmation that precedes it.
 */
export interface ChatRestoreFilesPreview {
    /**
     * `false` when the provider cannot preview a restore, so the Client shows no list.
     */
    supported: boolean;
    files: Array<{ path: string; additions?: number; deletions?: number }>;
    totalFiles: number;
    insertions?: number;
    deletions?: number;
}

/**
 * The parts of `AgentChatService` a preview drives: the per-Chat send chain, so the dry run sees the Chat between two
 * inputs, as the restore itself does.
 */
interface ChatPreviewHost {
    options: AgentChatServiceOptions;
    enqueue: (terminalId: string, deliver: ChatStateDelivery) => Promise<void>;
}

/**
 * `path` relative to the Chat's folder when it lies inside it, otherwise unchanged. The provider may name files by
 * absolute path while the Client shows project-relative ones.
 */
function chatRelativePath(path: string, cwd: string): string {
    const root = cwd.endsWith('/') ? cwd : `${cwd}/`;
    return path.startsWith(root) ? path.slice(root.length) : path;
}

/**
 * Per-file line counts from the Agent's own recorded edits in the turns a restore would revert, by path relative to the
 * Chat's folder. The provider's dry run reports totals only, so these give each listed file its `+N -M`; a file the
 * Chat recorded no edit for (changed by a shell command, or by the user) gets none.
 */
function recordedEditStats(
    snapshot: Pick<AgentChatSnapshot, 'items' | 'turns'>,
    keptTurns: number,
    cwd: string,
): Map<string, { additions: number; deletions: number }> {
    const revertedTurns = new Set(snapshot.turns.slice(keptTurns).map((turn) => turn.id));
    const items: AgentChatItem[] = snapshot.items.filter(
        (item) => item.turnId !== undefined && revertedTurns.has(item.turnId),
    );
    const stats = new Map<string, { additions: number; deletions: number }>();
    for (const file of collectAgentChatEditedFiles(items))
        stats.set(chatRelativePath(file.path, cwd), {
            additions: file.additions,
            deletions: file.deletions,
        });
    return stats;
}

/**
 * Combines the provider's dry run with the Chat's recorded edits into the preview a Client lists.
 */
function restorePreviewResult(
    preview: ChatRestorePreview,
    stats: ReadonlyMap<string, { additions: number; deletions: number }>,
    cwd: string,
): ChatRestoreFilesPreview {
    const paths = [...new Set(preview.files.map((path) => chatRelativePath(path, cwd)))];
    return {
        supported: true,
        files: paths.slice(0, MAX_PREVIEW_FILES).map((path) => ({ path, ...stats.get(path) })),
        totalFiles: paths.length,
        ...(preview.insertions !== undefined && { insertions: preview.insertions }),
        ...(preview.deletions !== undefined && { deletions: preview.deletions }),
    };
}

/**
 * "Restore code to here", dry run: lists the files the restore would put back without touching any, so the confirmation
 * can show its reach. Applies the restore's refusals (a running turn, a message that did not start its turn), so an
 * answer means the restore would be attempted. A provider with no preview answers `supported: false`.
 */
export async function previewChatRestore(
    host: ChatPreviewHost,
    terminalId: string,
    itemId: string,
): Promise<ChatRestoreFilesPreview> {
    const terminal = requireChatTerminal(host.options.database, terminalId);
    if (!agentProviderCatalog[terminal.provider].capabilities.chatRewindFiles)
        return { supported: false, files: [], totalFiles: 0 };
    let result: ChatRestoreFilesPreview = { supported: false, files: [], totalFiles: 0 };
    await host.enqueue(terminalId, async (session, state) => {
        const { snapshot } = state.projection;
        const target = agentChatRewindTarget(snapshot, itemId);
        if ('refusal' in target) {
            throw new CaxriError('CONFLICT', REFUSALS[target.refusal]);
        }
        if (!session.previewRestoreFiles) return;
        const item = snapshot.items.find((candidate) => candidate.id === itemId);
        const preview = await session.previewRestoreFiles({
            ...target.target,
            text: item?.type === 'userMessage' ? item.text : '',
            restoreFiles: true,
        });
        result = restorePreviewResult(
            preview,
            recordedEditStats(snapshot, target.target.keptTurns, terminal.cwd),
            terminal.cwd,
        );
    });
    return result;
}

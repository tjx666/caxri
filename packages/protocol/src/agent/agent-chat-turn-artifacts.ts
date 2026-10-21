import { pathBasename } from '@caxri/utils';

import type { AgentChatItem } from './agent-chat-contract.js';
import type {
    AgentChatDiffLine,
    AgentChatDiffStat,
    AgentChatFileChange,
} from './agent-chat-diff.js';
import { agentChatDiffLines, agentChatDiffLinesStat } from './agent-chat-diff.js';
import type { AgentChatLabelTranslate } from './agent-chat-labels.js';
import { translateAgentChatLabel } from './agent-chat-labels.js';
import type { AgentChatTrackerArtifact } from './trackers/agent-chat-tracker-artifact.js';
import { collectAgentChatTrackers } from './trackers/agent-chat-trackers.js';

/**
 * One file a finished turn changed, merged across every edit the turn made to it.
 */
export interface AgentChatEditedFile extends AgentChatDiffStat {
    path: string;
    /**
     * What the turn did to the file overall: `add` when it created it, `delete` when it removed a file that existed
     * before, `update` otherwise.
     */
    kind: AgentChatFileChange['kind'];
    /**
     * Every completed change to this path, oldest first; undoing replays them backwards.
     */
    changes: readonly AgentChatFileChange[];
    /**
     * Whether Server Core cut any of the diffs, which leaves the turn's changes to this file unknown in part.
     */
    truncated: boolean;
}

/**
 * What a finished turn left behind: the files it changed and the issues and pull requests it created or edited.
 */
export interface AgentChatTurnArtifacts {
    turnId: string;
    files: readonly AgentChatEditedFile[];
    trackers: readonly AgentChatTrackerArtifact[];
    /**
     * Set by the Client when the projection's item budget dropped the start of this turn, so `files` covers only what
     * remained and Undo would restore part of the turn: a file created and then edited would only lose the edit.
     */
    isPartial?: true;
}

function netKind(changes: readonly AgentChatFileChange[]): AgentChatFileChange['kind'] | undefined {
    const first = changes.at(0)?.kind;
    const last = changes.at(-1)?.kind;
    if (first === 'add') return last === 'delete' ? undefined : 'add';
    return last === 'delete' ? 'delete' : 'update';
}

/**
 * The files a turn's completed changes touched, in the order first changed. A file the turn created and then deleted
 * again left nothing behind, so it is not listed. A change the user declined or that failed never reached the disk.
 */
export function collectAgentChatEditedFiles(
    items: readonly AgentChatItem[],
): AgentChatEditedFile[] {
    const byPath = new Map<string, AgentChatFileChange[]>();
    for (const item of items) {
        if (item.type !== 'fileChange' || item.status !== 'completed') continue;
        for (const change of item.changes) {
            const changes = byPath.get(change.path);
            if (changes) changes.push(change);
            else byPath.set(change.path, [change]);
        }
    }
    return [...byPath].flatMap(([path, changes]) => {
        const kind = netKind(changes);
        if (!kind) return [];
        const stat = agentChatDiffLinesStat(
            changes.flatMap((change) => agentChatDiffLines(change)),
        );
        return [
            {
                path,
                kind,
                changes,
                truncated: changes.some((change) => change.truncated === true),
                ...stat,
            },
        ];
    });
}

/**
 * One file's diff lines across every change the turn made to it, each change's patch after the previous one.
 */
export function agentChatEditedFileLines(file: AgentChatEditedFile): AgentChatDiffLine[] {
    return file.changes.flatMap((change) => agentChatDiffLines(change));
}

export function agentChatEditedFilesStat(files: readonly AgentChatDiffStat[]): AgentChatDiffStat {
    return {
        additions: files.reduce((total, file) => total + file.additions, 0),
        deletions: files.reduce((total, file) => total + file.deletions, 0),
    };
}

/**
 * `Edited app.ts`, `Created app.ts`, `Deleted app.ts`, or `Edited 3 files`, the Codex app's turn summary title.
 */
export function agentChatEditedFilesTitle(
    files: ReadonlyArray<Pick<AgentChatEditedFile, 'kind' | 'path'>>,
    t: AgentChatLabelTranslate = translateAgentChatLabel,
): string {
    const only = files.at(0);
    if (!only || files.length !== 1)
        return t('agentChat.artifacts.editedFiles', { count: files.length });
    const name = pathBasename(only.path);
    if (only.kind === 'add') return t('agentChat.artifacts.createdFile', { name });
    if (only.kind === 'delete') return t('agentChat.artifacts.deletedFile', { name });
    return t('agentChat.artifacts.editedFile', { name });
}

/**
 * The artifacts of one finished turn, or `undefined` when it changed no file and filed nothing.
 */
export function collectAgentChatTurnArtifacts(
    turnId: string,
    items: readonly AgentChatItem[],
): AgentChatTurnArtifacts | undefined {
    const files = collectAgentChatEditedFiles(items);
    const trackers = collectAgentChatTrackers(items);
    if (files.length === 0 && trackers.length === 0) return undefined;
    return { turnId, files, trackers };
}

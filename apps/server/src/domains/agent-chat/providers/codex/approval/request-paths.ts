import type { AgentChatItem } from '@caxri/protocol';
import { MAX_AGENT_CHAT_FILE_CHANGES } from '@caxri/protocol';

import { isRecord } from '../../../chat-items';

type Json = Record<string, unknown>;

/**
 * Longest path the projection keeps; a path this long may have been clipped.
 */
const MAX_PATH_CHARS = 4_096;

/**
 * Marks a raw Codex file change that the projected `add`/`delete`/`update` kinds cannot tell from a plain edit: an
 * `update` that moves the file (`move_path`), or a kind this build does not know. The item mapper maps every unknown
 * kind to `update` and drops `move_path`, so without the mark a rename looks like an in-place edit of one path.
 */
export function renamedMarker(change: Json): Record<never, never> | { renamed: true } {
    const kind = isRecord(change.kind) ? change.kind : undefined;
    if (!kind) return {};
    if (kind.type === 'add' || kind.type === 'delete') return {};
    if (kind.type !== 'update') return { renamed: true };
    return typeof kind.move_path === 'string' && kind.move_path !== '' ? { renamed: true } : {};
}

/**
 * The paths of a file-change approval, or `undefined` unless they are provably the complete set of files the approval
 * touches. An incomplete list must read as "no paths known": a partial list that looks whole would let a parent Agent
 * approve a write it never saw.
 *
 * Complete means all of: the source item exists; it holds fewer than the item mapper's change cap (exactly the cap is
 * ambiguous, since the mapper slices to it); every change has a non-empty path shorter than the projection's cap; every
 * change is an `add` or an `update` that does not move the file; and the approval asks for no widened root
 * (`grantRoot`).
 */
export function completeCodexPaths(
    item: AgentChatItem | undefined,
    parameters: Json,
): string[] | undefined {
    if (item?.type !== 'fileChange') return undefined;
    if (typeof parameters.grantRoot === 'string' && parameters.grantRoot !== '') return undefined;
    const { changes } = item;
    if (changes.length === 0 || changes.length >= MAX_AGENT_CHAT_FILE_CHANGES) return undefined;
    const paths: string[] = [];
    for (const change of changes) {
        if (change.path === '' || change.path.length >= MAX_PATH_CHARS) return undefined;
        if (change.kind === 'delete' || change.renamed) return undefined;
        paths.push(change.path);
    }
    return paths;
}

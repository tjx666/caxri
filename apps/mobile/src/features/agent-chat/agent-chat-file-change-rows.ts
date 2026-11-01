import type { AgentChatDiffLine, AgentChatFileChange } from '@caxri/protocol';

import type { DiffLine } from '../changes/changes-model';

const DIFF_MARKER: Record<AgentChatDiffLine['kind'], DiffLine['marker']> = {
    added: '+',
    removed: '−',
    context: ' ',
    hunk: ' ',
    meta: ' ',
};

/**
 * A Chat file change's display lines in the row shape the Changes tab draws, so a Chat diff reads like every other diff
 * on the phone.
 */
export function agentChatChangeRows(lines: readonly AgentChatDiffLine[]): DiffLine[] {
    return lines.map((line, index) => ({
        id: String(index),
        kind: line.kind,
        content: line.text,
        oldLine: line.oldLine ?? null,
        newLine: line.newLine ?? null,
        marker: DIFF_MARKER[line.kind],
    }));
}

/**
 * The status letter's color slot for a change kind, matching the letter Desktop paints in the file's `--git-*` color.
 */
export function agentChatChangeColor(
    kind: AgentChatFileChange['kind'],
): 'gitAdded' | 'gitDeleted' | 'gitModified' {
    switch (kind) {
        case 'add': {
            return 'gitAdded';
        }
        case 'delete': {
            return 'gitDeleted';
        }
        case 'update': {
            return 'gitModified';
        }
    }
}

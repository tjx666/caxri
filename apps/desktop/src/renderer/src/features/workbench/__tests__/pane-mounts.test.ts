import type { PaneNode } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { reconcilePaneMounts } from '../pane-mounts';

function pane(id: string, terminalId?: string): PaneNode {
    return {
        id,
        type: 'pane',
        activeTabId: `${id}-tab`,
        tabs: [
            {
                id: `${id}-tab`,
                resource: terminalId
                    ? { kind: 'terminal', terminalId }
                    : { kind: 'file', path: '/fixture/file.txt' },
            },
        ],
    };
}

describe('reconcilePaneMounts', () => {
    it('preserves a visible Terminal across independent Root layouts', () => {
        const before = reconcilePaneMounts([], [pane('owner', 'terminal')]);
        const after = reconcilePaneMounts(before, [pane('worktree', 'terminal')]);
        expect(after[0].key).toBe(before[0].key);
        expect(after[0].pane.id).toBe('worktree');
        expect(reconcilePaneMounts(after, [pane('owner', 'terminal')])[0].key).toBe(before[0].key);
    });

    it('keeps ordinary tab navigation in the same pane mounted', () => {
        const before = reconcilePaneMounts([], [pane('pane', 'first')]);
        const editor = reconcilePaneMounts(before, [pane('pane')]);
        const terminal = reconcilePaneMounts(editor, [pane('pane', 'second')]);
        expect(editor[0].key).toBe(before[0].key);
        expect(terminal[0].key).toBe(before[0].key);
    });

    it('reserves surviving Terminals before reusing pane identities during splits', () => {
        const before = reconcilePaneMounts([], [pane('first', 'terminal')]);
        const split = reconcilePaneMounts(before, [pane('first'), pane('second', 'terminal')]);
        expect(split[1].key).toBe(before[0].key);
        expect(split[0].key).not.toBe(split[1].key);
        const collapsed = reconcilePaneMounts(split, [pane('first', 'terminal')]);
        expect(collapsed[0].key).toBe(before[0].key);
    });

    it('preserves both visible Terminals when their panes swap', () => {
        const before = reconcilePaneMounts([], [pane('first', 'a'), pane('second', 'b')]);
        const after = reconcilePaneMounts(before, [pane('first', 'b'), pane('second', 'a')]);
        expect(after.map(({ key }) => key)).toEqual([before[1].key, before[0].key]);
    });

    it('does not retain closed panes or infer document identity across Roots', () => {
        const before = reconcilePaneMounts([], [pane('owner')]);
        expect(reconcilePaneMounts(before, [pane('worktree')])[0].key).not.toBe(before[0].key);
        expect(reconcilePaneMounts(before, [])).toEqual([]);
    });
});

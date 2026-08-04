import { describe, expect, it } from 'vitest';

import {
    addTerminal,
    createTerminalLayout,
    listLayoutTerminalIds,
    moveTerminal,
    removeTerminal,
    resizeSplit,
    selectTerminal,
    splitTerminal,
} from '../terminal-layout';

const ids = (() => {
    let value = 0;
    return () => `node-${++value}`;
})();

describe('Terminal layout reducer', () => {
    it('splits right and down while preserving every live Terminal identity', () => {
        let layout = createTerminalLayout('terminal-1', ids);
        layout = splitTerminal(layout, 'terminal-2', layout.activeGroupId!, 'horizontal', ids);
        const secondGroupId = layout.activeGroupId!;
        layout = splitTerminal(layout, 'terminal-3', secondGroupId, 'vertical', ids);

        expect(listLayoutTerminalIds(layout)).toEqual(['terminal-1', 'terminal-2', 'terminal-3']);
        expect(layout.root).toMatchObject({
            type: 'split',
            direction: 'horizontal',
            second: { type: 'split', direction: 'vertical' },
        });
    });

    it('moves Terminals between groups and collapses an empty source group', () => {
        let layout = createTerminalLayout('terminal-1', ids);
        const firstGroupId = layout.activeGroupId!;
        layout = splitTerminal(layout, 'terminal-2', firstGroupId, 'horizontal', ids);
        const secondGroupId = layout.activeGroupId!;

        layout = moveTerminal(layout, 'terminal-1', secondGroupId);

        expect(layout.root).toMatchObject({
            type: 'group',
            id: secondGroupId,
            terminalIds: ['terminal-2', 'terminal-1'],
            activeTerminalId: 'terminal-1',
        });
    });

    it('selects an existing Terminal, adds a missing Terminal, and clamps split ratios', () => {
        let layout = createTerminalLayout('terminal-1', ids);
        const firstGroupId = layout.activeGroupId!;
        layout = splitTerminal(layout, 'terminal-2', firstGroupId, 'horizontal', ids);
        const splitId = layout.root!.id;
        layout = selectTerminal(layout, 'terminal-1');
        layout = addTerminal(layout, 'terminal-3', layout.activeGroupId, ids);
        layout = resizeSplit(layout, splitId, 0.99);

        expect(layout.activeGroupId).toBe(firstGroupId);
        expect(listLayoutTerminalIds(layout)).toEqual(['terminal-1', 'terminal-3', 'terminal-2']);
        expect(layout.root).toMatchObject({ type: 'split', ratio: 0.85 });
    });

    it('removes only the empty group when its final Terminal closes', () => {
        let layout = createTerminalLayout('terminal-1', ids);
        layout = splitTerminal(layout, 'terminal-2', layout.activeGroupId!, 'horizontal', ids);

        layout = removeTerminal(layout, 'terminal-2');

        expect(layout.root).toMatchObject({
            type: 'group',
            terminalIds: ['terminal-1'],
        });
        expect(layout.activeGroupId).toBe(layout.root!.id);
    });
});

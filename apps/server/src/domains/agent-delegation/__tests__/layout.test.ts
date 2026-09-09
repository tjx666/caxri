import { addPaneTerminalSilently, createPaneLayout, findResourceTabs } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { assertDelegationLayout, delegationLayout } from '../layout';

describe('delegationLayout', () => {
    it('rejects a full pane tree before child insertion', () => {
        let layout = createPaneLayout({ kind: 'terminal', terminalId: 'caller' });
        for (let index = 0; index < 7; index++) {
            const child = `child-${index}`;
            layout = delegationLayout(addPaneTerminalSilently(layout, child), child, 'caller');
        }
        expect(() => assertDelegationLayout(layout, 'caller')).toThrow(/No space/u);
        expect(() => assertDelegationLayout(createPaneLayout(), 'missing')).toThrow(/caller pane/u);
    });

    it.each([
        [{ cols: 200, rows: 40 }, 'horizontal'],
        [{ cols: 90, rows: 60 }, 'vertical'],
    ] as const)(
        'splits beside the caller without changing its active tab for %j',
        (size, direction) => {
            const before = addPaneTerminalSilently(
                createPaneLayout({ kind: 'terminal', terminalId: 'caller' }),
                'child',
            );
            const after = delegationLayout(before, 'child', 'caller', size);
            expect(after.root.type).toBe('split');
            expect(after.root.type === 'split' && after.root.direction).toBe(direction);
            expect(after.activePaneId).toBe(before.activePaneId);
            const caller = findResourceTabs(after, { kind: 'terminal', terminalId: 'caller' })[0];
            const child = findResourceTabs(after, { kind: 'terminal', terminalId: 'child' })[0];
            expect(caller.pane.id).not.toBe(child.pane.id);
            expect(caller.pane.activeTabId).toBe(caller.tab.id);
        },
    );
});

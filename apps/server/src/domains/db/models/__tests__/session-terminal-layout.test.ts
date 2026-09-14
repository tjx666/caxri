import {
    addPaneTerminalSilently,
    createPaneLayout,
    findResourceTabs,
    listPaneTerminalIds,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { delegationLayout } from '../../../agent-delegation/layout';
import { reconcileOwnedTerminalTabs, resolveSessionPaneLayout } from '../session-terminal-layout';

/**
 * The arrangement the Server builds for a delegation: caller and child in sibling panes.
 */
function delegatedLayout() {
    return delegationLayout(
        addPaneTerminalSilently(
            createPaneLayout({ kind: 'terminal', terminalId: 'caller' }),
            'child',
        ),
        'child',
        'caller',
    );
}

describe('resolveSessionPaneLayout', () => {
    it('keeps the Server-built split when the write predates the delegated Terminal', () => {
        const stored = delegatedLayout();
        const incoming = createPaneLayout({ kind: 'terminal', terminalId: 'caller' });

        const resolved = resolveSessionPaneLayout(incoming, stored, ['caller', 'child']);

        expect(resolved.root.type).toBe('split');
        const caller = findResourceTabs(resolved, { kind: 'terminal', terminalId: 'caller' })[0];
        const child = findResourceTabs(resolved, { kind: 'terminal', terminalId: 'child' })[0];
        expect(caller.pane.id).not.toBe(child.pane.id);
    });

    it('persists the incoming arrangement once the write knows about every owned Terminal', () => {
        const stored = delegatedLayout();
        const incoming = addPaneTerminalSilently(
            createPaneLayout({ kind: 'terminal', terminalId: 'caller' }),
            'child',
        );

        const resolved = resolveSessionPaneLayout(incoming, stored, ['caller', 'child']);

        expect(resolved.root.type).toBe('pane');
        expect(listPaneTerminalIds(resolved)).toEqual(['caller', 'child']);
    });

    it('reconciles into the incoming layout when the stored one never placed the Terminal either', () => {
        const stored = createPaneLayout({ kind: 'terminal', terminalId: 'caller' });
        const incoming = createPaneLayout({ kind: 'terminal', terminalId: 'caller' });

        const resolved = resolveSessionPaneLayout(incoming, stored, ['caller', 'child']);

        expect(listPaneTerminalIds(resolved)).toEqual(
            listPaneTerminalIds(reconcileOwnedTerminalTabs(incoming, ['caller', 'child'])),
        );
    });

    it('reconciles into the incoming layout when nothing is stored yet', () => {
        const incoming = createPaneLayout({ kind: 'terminal', terminalId: 'caller' });

        const resolved = resolveSessionPaneLayout(incoming, undefined, ['caller', 'child']);

        expect(listPaneTerminalIds(resolved)).toContain('child');
    });

    it('still prunes a Terminal the Server no longer owns out of the stored arrangement', () => {
        const stored = delegatedLayout();
        const incoming = createPaneLayout({ kind: 'terminal', terminalId: 'caller' });

        const resolved = resolveSessionPaneLayout(incoming, stored, ['child']);

        expect(listPaneTerminalIds(resolved)).toEqual(['child']);
    });
});

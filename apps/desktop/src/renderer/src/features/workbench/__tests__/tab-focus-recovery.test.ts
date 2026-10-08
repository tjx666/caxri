import { activePane, createPaneLayout, openResource } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { planTabFocusRecovery } from '../tab-focus-recovery';

const ids = (): (() => string) => {
    let next = 0;
    return () => `id-${++next}`;
};

function terminalActiveLayout() {
    const id = ids();
    return openResource(
        createPaneLayout({ kind: 'file', path: '/repo/README.md' }, id),
        { kind: 'terminal', terminalId: 'terminal-new' },
        {},
        id,
    );
}

function editorActiveLayout() {
    const id = ids();
    return openResource(
        createPaneLayout({ kind: 'terminal', terminalId: 'terminal-old' }, id),
        { kind: 'file', path: '/repo/README.md' },
        {},
        id,
    );
}

describe('planTabFocusRecovery', () => {
    it('does nothing when focus was outside the panes or there is no layout', () => {
        expect(planTabFocusRecovery(terminalActiveLayout(), 'none')).toBeUndefined();
        expect(planTabFocusRecovery(undefined, 'tab-bar')).toBeUndefined();
    });

    it('lets an activated Terminal claim focus itself when focus came from pane content', () => {
        // Regression: `Cmd+T` / "+" from inside xterm disposed the old xterm, focus fell to `body`, and the recovery
        // handed the new tab button `preserveTerminalFocus` for the very Terminal it was vetoing, so the new
        // Terminal never focused and the tab wore a keyboard focus ring.
        expect(planTabFocusRecovery(terminalActiveLayout(), 'content')).toBeUndefined();
    });

    it('keeps WAI-ARIA tab focus on a Terminal tab when the user was navigating the tab bar', () => {
        const layout = terminalActiveLayout();
        expect(planTabFocusRecovery(layout, 'tab-bar')).toEqual({
            paneId: layout.activePaneId,
            preserveTerminalFocus: true,
            tabId: activePane(layout).activeTabId,
        });
    });

    it('focuses a non-Terminal tab from either origin without the Terminal marker', () => {
        const layout = editorActiveLayout();
        for (const origin of ['content', 'tab-bar'] as const)
            expect(planTabFocusRecovery(layout, origin)).toEqual({
                paneId: layout.activePaneId,
                preserveTerminalFocus: false,
                tabId: activePane(layout).activeTabId,
            });
    });
});

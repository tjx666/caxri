import type { SessionWorkSummary } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { MenuBarActions } from '../menu-bar-menu';
import { buildMenuBarMenu, menuBarTitle } from '../menu-bar-menu';

const quiet: SessionWorkSummary = { working: 0, usageWaiting: 0, attentionCount: 0, attention: [] };

function actions(): MenuBarActions {
    return { openSession: vi.fn(), openWindow: vi.fn(), quit: vi.fn(), setKeepAwake: vi.fn() };
}

const labels = (items: ReturnType<typeof buildMenuBarMenu>): Array<string | undefined> =>
    items.map((item) => (item.type === 'separator' ? '---' : item.label));

describe('menuBarTitle', () => {
    it('shows a number only when Sessions need the user', () => {
        expect(menuBarTitle(undefined)).toBe('');
        expect(menuBarTitle({ ...quiet, working: 4 })).toBe('');
        expect(menuBarTitle({ ...quiet, attentionCount: 3 })).toBe('3');
    });
});

describe('buildMenuBarMenu', () => {
    it('keeps only the app actions when the Server is unreachable', () => {
        const items = buildMenuBarMenu(undefined, actions());
        expect(labels(items)).toEqual(['Open Caxri', '---', 'Quit Caxri']);
    });

    it('shows status, the Sessions that need the user, and the keep-awake switch', () => {
        const handlers = actions();
        const items = buildMenuBarMenu(
            {
                summary: {
                    working: 2,
                    usageWaiting: 1,
                    attentionCount: 10,
                    attention: [
                        {
                            sessionId: 's1',
                            title: 'Fix login',
                            projectTitle: 'App',
                            kind: 'waiting',
                        },
                    ],
                },
                isKeepingAwake: true,
                isKeepAwakeEnabled: true,
            },
            handlers,
        );
        expect(labels(items)).toEqual([
            '2 Agents working',
            '1 Chat waiting for a plan limit to reset',
            'Keeping this Mac awake',
            '---',
            'Needs You',
            'Fix login',
            '9 More in Caxri',
            '---',
            'Keep Mac Awake While Agents Work',
            '---',
            'Open Caxri',
            '---',
            'Quit Caxri',
        ]);
        const session = items.find((item) => item.label === 'Fix login');
        expect(session?.sublabel).toBe('App · Waiting for you');
        session?.click?.({} as never, undefined, {});
        expect(handlers.openSession).toHaveBeenCalledWith('s1');

        const keepAwake = items.find((item) => item.type === 'checkbox');
        expect(keepAwake?.checked).toBe(true);
        keepAwake?.click?.({} as never, undefined, {});
        expect(handlers.setKeepAwake).toHaveBeenCalledWith(false);
    });
});

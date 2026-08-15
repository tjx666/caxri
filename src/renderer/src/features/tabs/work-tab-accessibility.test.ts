import { describe, expect, it } from 'vitest';

import type { WorkItem } from '@shared/work-item';

import {
    processStateDescription,
    workPanelId,
    workTabId,
    workTabNavigationTarget,
} from './work-tab-accessibility';

const terminal = (terminalId: string): WorkItem => ({ kind: 'terminal', terminalId });
const editor = (path: string): WorkItem => ({ kind: 'editor', path });

describe('work tab accessibility', () => {
    const items = [terminal('term:one'), editor('/repo/a file.ts'), editor('/repo/b.ts')];

    it('creates stable, bounded IDs that do not expose a path', () => {
        const item = editor(`/repo/${'very-long '.repeat(100)}file.ts`);
        const tabId = workTabId('session:one', item);
        expect(tabId).toMatch(/^work-tab-[a-z0-9]+-[a-z0-9]+$/);
        expect(tabId.length).toBeLessThan(40);
        expect(tabId).toBe(workTabId('session:one', item));
        expect(tabId).not.toContain('file');
        expect(workPanelId('session:one', item)).toBe(`${tabId}-panel`);
        expect(workTabId('session:two', item)).not.toBe(tabId);
    });

    it('wraps arrow navigation and moves directly to the ends', () => {
        expect(workTabNavigationTarget(items, items[0], 'ArrowLeft')).toEqual(items[2]);
        expect(workTabNavigationTarget(items, items[2], 'ArrowRight')).toEqual(items[0]);
        expect(workTabNavigationTarget(items, items[1], 'Home')).toEqual(items[0]);
        expect(workTabNavigationTarget(items, items[1], 'End')).toEqual(items[2]);
    });

    it('uses the first tab as a deterministic arrow-navigation fallback', () => {
        expect(workTabNavigationTarget(items, terminal('missing'), 'ArrowRight')).toEqual(items[0]);
        expect(workTabNavigationTarget(items, terminal('missing'), 'ArrowLeft')).toEqual(items[2]);
        expect(workTabNavigationTarget([], undefined, 'Home')).toBeUndefined();
    });

    it.each([
        ['starting', 'Terminal is starting'],
        ['running', 'Terminal is running'],
        ['stopped', 'Terminal is stopped'],
        ['dead', 'Terminal has stopped unexpectedly'],
        ['failed', 'Terminal failed'],
        ['interrupted', 'Terminal was interrupted'],
    ] as const)('describes %s terminal state', (state, description) => {
        expect(processStateDescription(state)).toBe(description);
    });
});

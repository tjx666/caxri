import { describe, expect, it } from 'vitest';

import {
    workPanelId,
    workTabDescription,
    workTabId,
    workTabNavigationTarget,
} from '../work-tab-accessibility';

describe('work tab accessibility', () => {
    const tabIds = ['tab-1', 'tab-2', 'tab-3'];

    it('derives DOM ids from the tab occurrence id alone', () => {
        expect(workTabId('tab-1')).toBe('work-tab-tab-1');
        expect(workPanelId('tab-1')).toBe('work-tab-tab-1-panel');
        expect(workTabId('tab-2')).not.toBe(workTabId('tab-1'));
    });

    it('wraps arrow navigation and moves directly to the ends', () => {
        expect(workTabNavigationTarget(tabIds, tabIds[0], 'ArrowLeft')).toBe(tabIds[2]);
        expect(workTabNavigationTarget(tabIds, tabIds[2], 'ArrowRight')).toBe(tabIds[0]);
        expect(workTabNavigationTarget(tabIds, tabIds[1], 'Home')).toBe(tabIds[0]);
        expect(workTabNavigationTarget(tabIds, tabIds[1], 'End')).toBe(tabIds[2]);
    });

    it('uses the first tab as a deterministic arrow-navigation fallback', () => {
        expect(workTabNavigationTarget(tabIds, 'missing', 'ArrowRight')).toBe(tabIds[0]);
        expect(workTabNavigationTarget(tabIds, 'missing', 'ArrowLeft')).toBe(tabIds[2]);
        expect(workTabNavigationTarget([], undefined, 'Home')).toBeUndefined();
    });

    it('describes the detail, hidden fact, Git state, and unsaved buffer in a stable order', () => {
        expect(workTabDescription({})).toBe('');
        expect(
            workTabDescription({
                accessibleDetail: 'Outside every Project',
                detail: 'docs',
                dirty: true,
                gitDecoration: { kind: 'modified' },
            }),
        ).toBe('In docs. Outside every Project. Git: modified. Unsaved changes.');
        expect(workTabDescription({ dirty: true })).toBe('Unsaved changes.');
    });
});

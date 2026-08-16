import { describe, expect, it } from 'vitest';

import { createTerminalLayout, splitTerminal } from '../terminal-layout';
import type { SessionState } from '../types';
import { activateWorkState, areWorkItemsEqual, resolveActiveWork, workItemKey } from '../work-item';

const ids = (() => {
    let value = 0;
    return () => `node-${++value}`;
})();

function baseState(overrides: Partial<SessionState> = {}): SessionState {
    return {
        sessionId: 'session-1',
        workbenchProjectId: 'project-1',
        openTabs: [],
        inspectorMode: 'files',
        layout: createTerminalLayout('terminal-1', ids),
        ...overrides,
    };
}

describe('workItemKey', () => {
    it('returns a distinct stable key per kind and identity', () => {
        expect(workItemKey({ kind: 'terminal', terminalId: 'a' })).toBe('terminal:a');
        expect(workItemKey({ kind: 'editor', path: '/a' })).toBe('editor:/a');
        expect(workItemKey(undefined)).toBe('none');
        expect(workItemKey({ kind: 'terminal', terminalId: 'a' })).not.toBe(
            workItemKey({ kind: 'editor', path: 'a' }),
        );
    });
});

describe('areWorkItemsEqual', () => {
    it('compares by kind and identity, not by reference', () => {
        expect(
            areWorkItemsEqual(
                { kind: 'terminal', terminalId: 'a' },
                { kind: 'terminal', terminalId: 'a' },
            ),
        ).toBe(true);
        expect(
            areWorkItemsEqual(
                { kind: 'terminal', terminalId: 'a' },
                { kind: 'terminal', terminalId: 'b' },
            ),
        ).toBe(false);
        expect(
            areWorkItemsEqual(
                { kind: 'editor', path: '/a' },
                { kind: 'terminal', terminalId: '/a' },
            ),
        ).toBe(false);
        expect(areWorkItemsEqual(undefined, undefined)).toBe(true);
        expect(areWorkItemsEqual({ kind: 'editor', path: '/a' }, undefined)).toBe(false);
    });
});

describe('resolveActiveWork', () => {
    it('prefers the local activeWork when its target still exists', () => {
        const sessionState = baseState({ openTabs: [{ path: '/a.ts', dirty: false }] });
        const resolved = resolveActiveWork({
            activeWork: { kind: 'editor', path: '/a.ts' },
            sessionTerminals: [{ id: 'terminal-1' }],
            sessionState,
        });
        expect(resolved).toEqual({ kind: 'editor', path: '/a.ts' });
    });

    it('falls back to the persisted activeTab when local activeWork is gone (closed tab)', () => {
        const sessionState = baseState({
            openTabs: [{ path: '/b.ts', dirty: false }],
            activeTab: { kind: 'editor', path: '/b.ts' },
        });
        const resolved = resolveActiveWork({
            activeWork: { kind: 'editor', path: '/a.ts' }, // closed, no longer in openTabs
            sessionTerminals: [{ id: 'terminal-1' }],
            sessionState,
        });
        expect(resolved).toEqual({ kind: 'editor', path: '/b.ts' });
    });

    it('skips a stale persisted activeTab whose Terminal was removed and falls back to layout', () => {
        const sessionState = baseState({
            activeTab: { kind: 'terminal', terminalId: 'removed-terminal' },
        });
        const resolved = resolveActiveWork({
            activeWork: { kind: 'terminal', terminalId: 'also-removed' },
            sessionTerminals: [{ id: 'terminal-1' }],
            sessionState,
        });
        expect(resolved).toEqual({ kind: 'terminal', terminalId: 'terminal-1' });
    });

    it('falls back to the first Session Terminal when the layout has none', () => {
        const resolved = resolveActiveWork({
            sessionTerminals: [{ id: 'terminal-9' }],
            sessionState: undefined,
        });
        expect(resolved).toEqual({ kind: 'terminal', terminalId: 'terminal-9' });
    });

    it('falls back to the first open editor after every Terminal is removed', () => {
        const resolved = resolveActiveWork({
            activeWork: { kind: 'terminal', terminalId: 'removed-terminal' },
            sessionTerminals: [],
            sessionState: baseState({
                activeTab: { kind: 'terminal', terminalId: 'removed-terminal' },
                openTabs: [
                    { path: '/first.ts', dirty: false },
                    { path: '/second.ts', dirty: false },
                ],
            }),
        });

        expect(resolved).toEqual({ kind: 'editor', path: '/first.ts' });
    });

    it('returns undefined when there is nothing to focus', () => {
        expect(
            resolveActiveWork({ sessionTerminals: [], sessionState: undefined }),
        ).toBeUndefined();
    });
});

describe('activateWorkState', () => {
    it('activating a Terminal syncs the layout active group and active Terminal', () => {
        let layout = createTerminalLayout('terminal-1', ids);
        layout = splitTerminal(layout, 'terminal-2', layout.activeGroupId!, 'horizontal', ids);
        const root = layout.root;
        const firstGroupId = root?.type === 'split' ? root.first.id : undefined;
        const state = baseState({ layout });

        const next = activateWorkState(state, { kind: 'terminal', terminalId: 'terminal-1' });

        expect(next.activeTab).toEqual({ kind: 'terminal', terminalId: 'terminal-1' });
        expect(next.layout.activeGroupId).toBe(firstGroupId);
    });

    it('activating an editor tab leaves the Terminal layout untouched', () => {
        const state = baseState({ openTabs: [{ path: '/a.ts', dirty: false }] });

        const next = activateWorkState(state, { kind: 'editor', path: '/a.ts' });

        expect(next.activeTab).toEqual({ kind: 'editor', path: '/a.ts' });
        expect(next.layout).toBe(state.layout);
    });

    it('is a no-op that returns the same state when the item is already active', () => {
        const state = baseState({ activeTab: { kind: 'terminal', terminalId: 'terminal-1' } });

        expect(activateWorkState(state, { kind: 'terminal', terminalId: 'terminal-1' })).toBe(
            state,
        );
    });
});

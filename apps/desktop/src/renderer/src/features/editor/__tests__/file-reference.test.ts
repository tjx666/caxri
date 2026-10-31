import type { PaneLayout, TerminalRecord } from '@caxri/protocol';
import {
    activePane,
    createPaneLayout,
    findResourceTabs,
    openResource,
    parseFileLocation,
    splitTabIntoPane,
} from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { chooseReferenceTerminal, formatFileReference } from '../file-reference';

function terminal(overrides: Partial<TerminalRecord> & Pick<TerminalRecord, 'id'>): TerminalRecord {
    return {
        sessionId: 'session-1',
        kind: 'shell',
        cwd: '/repo',
        title: overrides.id,
        orderIndex: 0,
        lastProcessState: 'running',
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

describe('formatFileReference', () => {
    it('mentions the Project-relative path with the cursor line and a trailing space', () => {
        expect(
            formatFileReference({
                path: '/repo/src/index.ts',
                projectRoot: '/repo',
                startLine: 12,
                endLine: 12,
            }),
        ).toBe('@src/index.ts#L12 ');
    });

    it('emits a GitHub-style line span for a multi-line selection', () => {
        expect(
            formatFileReference({
                path: '/repo/src/index.ts',
                projectRoot: '/repo',
                startLine: 3,
                endLine: 9,
            }),
        ).toBe('@src/index.ts#L3-L9 ');
    });

    it('falls back to the absolute path outside the Project root or without one', () => {
        expect(
            formatFileReference({
                path: '/elsewhere/notes.md',
                projectRoot: '/repo',
                startLine: 1,
                endLine: 1,
            }),
        ).toBe('@/elsewhere/notes.md#L1 ');
        expect(
            formatFileReference({
                path: '/repo/a.ts',
                projectRoot: undefined,
                startLine: 1,
                endLine: 1,
            }),
        ).toBe('@/repo/a.ts#L1 ');
    });

    it('round-trips through the Terminal file-location parser', () => {
        const reference = formatFileReference({
            path: '/repo/src/index.ts',
            projectRoot: '/repo',
            startLine: 3,
            endLine: 9,
        });
        expect(parseFileLocation(reference.trim().slice(1))).toEqual({
            target: 'src/index.ts',
            location: { mode: 'line', startLine: 3, endLine: 9 },
        });
    });
});

describe('chooseReferenceTerminal', () => {
    const terminals = [
        terminal({ id: 'old', createdAt: 1, orderIndex: 0 }),
        terminal({ id: 'newest', createdAt: 3, orderIndex: 2 }),
        terminal({ id: 'middle', createdAt: 2, orderIndex: 1 }),
        terminal({ id: 'other-session', sessionId: 'session-2', createdAt: 9 }),
    ];

    /**
     * Opens every id as a Terminal tab, then splits all but the last into their own pane so each one is on screen.
     */
    function layoutShowing(...visibleIds: string[]): PaneLayout {
        let layout = createPaneLayout({ kind: 'file', path: '/repo/a.ts' });
        for (const id of visibleIds)
            layout = openResource(layout, { kind: 'terminal', terminalId: id });
        const splitIds = visibleIds.slice(0, -1);
        for (const id of splitIds) {
            const occurrence = findResourceTabs(layout, { kind: 'terminal', terminalId: id })[0];
            layout = splitTabIntoPane(layout, occurrence.tab.id, activePane(layout).id, 'right');
        }
        return layout;
    }

    it('prefers the most recently opened Terminal among those on screen', () => {
        expect(
            chooseReferenceTerminal(terminals, 'session-1', layoutShowing('old', 'middle'))?.id,
        ).toBe('middle');
    });

    it('falls back to the newest Terminal of the Session when none is visible', () => {
        expect(chooseReferenceTerminal(terminals, 'session-1', undefined)?.id).toBe('newest');
    });

    it('breaks a createdAt tie by the higher order index', () => {
        const tied = [
            terminal({ id: 'first', createdAt: 5, orderIndex: 0 }),
            terminal({ id: 'second', createdAt: 5, orderIndex: 1 }),
        ];
        expect(chooseReferenceTerminal(tied, 'session-1', undefined)?.id).toBe('second');
    });

    it('never crosses into another Session', () => {
        expect(chooseReferenceTerminal(terminals, 'session-3', undefined)).toBeUndefined();
    });
});

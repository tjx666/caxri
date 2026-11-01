import type { DragEvent } from 'react';

import { describe, expect, it, vi } from 'vitest';

import {
    dropIntoProjectRoot,
    pasteIntoProjectRoot,
    refreshResourceExplorer,
} from '../hooks/use-resource-explorer-controller';

const context = {
    isBlocked: false,
    rootPath: '/project',
    sessionId: 'session-1',
};

function dragEvent(): { event: DragEvent; preventDefault: ReturnType<typeof vi.fn> } {
    const preventDefault = vi.fn();
    return { event: { preventDefault } as unknown as DragEvent, preventDefault };
}

describe('Resource Explorer controller workflows', () => {
    it('pastes into the Project root and selects every pasted path', async () => {
        const paste = vi.fn(() =>
            Promise.resolve([{ path: '/project/a copy.ts' }, { path: '/project/b copy.ts' }]),
        );
        const selectPaths = vi.fn();

        await pasteIntoProjectRoot(context, {
            draggedPaths: vi.fn(() => []),
            importDropped: vi.fn(),
            move: vi.fn(),
            paste,
            selectPaths,
        });

        expect(paste).toHaveBeenCalledWith('session-1', '/project');
        expect(selectPaths).toHaveBeenCalledWith(['/project/a copy.ts', '/project/b copy.ts']);
    });

    it('selects nothing when there was nothing to paste', async () => {
        const selectPaths = vi.fn();

        await pasteIntoProjectRoot(context, {
            draggedPaths: vi.fn(() => []),
            importDropped: vi.fn(),
            move: vi.fn(),
            paste: vi.fn(() => Promise.resolve([])),
            selectPaths,
        });

        expect(selectPaths).not.toHaveBeenCalled();
    });

    it('prevents the browser drop and preserves operation blocking before moving', async () => {
        const blockedEvent = dragEvent();
        const move = vi.fn(() =>
            Promise.resolve([{ path: '/project/a.ts' }, { path: '/project/b.ts' }]),
        );
        const importDropped = vi.fn();
        const selectPaths = vi.fn();
        const dependencies = {
            draggedPaths: vi.fn(() => ['/elsewhere/a.ts', '/elsewhere/b.ts']),
            importDropped,
            move,
            paste: vi.fn(),
            selectPaths,
        };

        await dropIntoProjectRoot(
            blockedEvent.event,
            { ...context, isBlocked: true },
            dependencies,
        );

        expect(blockedEvent.preventDefault).toHaveBeenCalledOnce();
        expect(move).not.toHaveBeenCalled();

        const allowedEvent = dragEvent();
        await dropIntoProjectRoot(allowedEvent.event, context, dependencies);

        expect(move).toHaveBeenCalledWith(
            'session-1',
            ['/elsewhere/a.ts', '/elsewhere/b.ts'],
            '/project',
        );
        expect(importDropped).not.toHaveBeenCalled();
        expect(selectPaths).toHaveBeenCalledWith(['/project/a.ts', '/project/b.ts']);
    });

    it('copies files dropped from Finder into the Project root', async () => {
        const { event } = dragEvent();
        const importDropped = vi.fn(() => Promise.resolve([{ path: '/project/photo.png' }]));
        const move = vi.fn();
        const selectPaths = vi.fn();

        await dropIntoProjectRoot(event, context, {
            draggedPaths: vi.fn(() => []),
            importDropped,
            move,
            paste: vi.fn(),
            selectPaths,
        });

        expect(importDropped).toHaveBeenCalledWith(event, 'session-1', '/project');
        expect(move).not.toHaveBeenCalled();
        expect(selectPaths).toHaveBeenCalledWith(['/project/photo.png']);
    });

    it('re-reveals the open file when refreshing, and refreshes regardless', () => {
        const revealPath = vi.fn();
        const runRefresh = vi.fn();
        const target = {
            activeFilePath: '/project/src/deep/source.ts',
            scopeId: 'session-1:project-1',
            sessionRootPath: '/project',
        };

        refreshResourceExplorer(target, { revealPath, runRefresh });

        expect(runRefresh).toHaveBeenCalledOnce();
        expect(revealPath).toHaveBeenCalledWith(
            'session-1:project-1',
            '/project',
            '/project/src/deep/source.ts',
        );

        // Nothing open, or no Session yet: the listing still has to be re-read, there is just nowhere to scroll to.
        for (const withoutTarget of [
            { ...target, activeFilePath: undefined },
            { ...target, scopeId: undefined },
            { ...target, sessionRootPath: undefined },
        ])
            refreshResourceExplorer(withoutTarget, { revealPath, runRefresh });

        expect(runRefresh).toHaveBeenCalledTimes(4);
        expect(revealPath).toHaveBeenCalledOnce();
    });
});

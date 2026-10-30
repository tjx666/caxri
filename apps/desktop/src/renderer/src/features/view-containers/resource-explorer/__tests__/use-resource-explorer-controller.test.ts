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
    it('pastes into the Project root and selects the pasted path', async () => {
        const paste = vi.fn(() => Promise.resolve({ path: '/project/source copy.ts' }));
        const selectPath = vi.fn();

        await pasteIntoProjectRoot(context, {
            draggedPath: vi.fn(),
            importDropped: vi.fn(),
            move: vi.fn(),
            paste,
            selectPath,
        });

        expect(paste).toHaveBeenCalledWith('session-1', '/project');
        expect(selectPath).toHaveBeenCalledWith('/project/source copy.ts');
    });

    it('selects nothing when there was nothing to paste', async () => {
        const selectPath = vi.fn();

        await pasteIntoProjectRoot(context, {
            draggedPath: vi.fn(),
            importDropped: vi.fn(),
            move: vi.fn(),
            paste: vi.fn(() => Promise.resolve(undefined)),
            selectPath,
        });

        expect(selectPath).not.toHaveBeenCalled();
    });

    it('prevents the browser drop and preserves operation blocking before moving', async () => {
        const blockedEvent = dragEvent();
        const move = vi.fn(() => Promise.resolve({ path: '/project/source.ts' }));
        const importDropped = vi.fn();
        const selectPath = vi.fn();
        const dependencies = {
            draggedPath: vi.fn(() => '/elsewhere/source.ts'),
            importDropped,
            move,
            paste: vi.fn(),
            selectPath,
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

        expect(move).toHaveBeenCalledWith('session-1', '/elsewhere/source.ts', '/project');
        expect(importDropped).not.toHaveBeenCalled();
        expect(selectPath).toHaveBeenCalledWith('/project/source.ts');
    });

    it('copies files dropped from Finder into the Project root', async () => {
        const { event } = dragEvent();
        const importDropped = vi.fn(() => Promise.resolve({ path: '/project/photo.png' }));
        const move = vi.fn();
        const selectPath = vi.fn();

        await dropIntoProjectRoot(event, context, {
            draggedPath: vi.fn(),
            importDropped,
            move,
            paste: vi.fn(),
            selectPath,
        });

        expect(importDropped).toHaveBeenCalledWith(event, 'session-1', '/project');
        expect(move).not.toHaveBeenCalled();
        expect(selectPath).toHaveBeenCalledWith('/project/photo.png');
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

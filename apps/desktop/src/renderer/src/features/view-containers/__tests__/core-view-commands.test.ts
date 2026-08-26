import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    dispatchCoreViewCommand,
    resetCoreViewCommandsForTests,
    subscribeCoreViewCommands,
} from '../core-view-commands';

afterEach(resetCoreViewCommandsForTests);

describe('Workbench Core view commands', () => {
    it('replays a command exactly once when its hidden controlled view mounts', () => {
        const command = {
            arguments: [],
            commandId: 'workbench.example.search',
            contextKey: 'session-a:project-a',
            role: 'resource.search' as const,
            viewId: 'workbench.example.view',
        };
        const listener = vi.fn();

        dispatchCoreViewCommand(command);
        const dispose = subscribeCoreViewCommands(command.viewId, command.contextKey, listener);
        dispose();
        subscribeCoreViewCommands(command.viewId, command.contextKey, listener);

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(command);
    });

    it('does not replay a hidden-view command into a later Session scope', () => {
        const command = {
            arguments: [],
            commandId: 'workbench.example.createFile',
            contextKey: 'session-a:project-a',
            role: 'resource.createFile' as const,
            viewId: 'workbench.example.view',
        };
        const sessionA = vi.fn();
        const sessionB = vi.fn();

        dispatchCoreViewCommand(command);
        subscribeCoreViewCommands(command.viewId, 'session-b:project-b', sessionB);
        subscribeCoreViewCommands(command.viewId, command.contextKey, sessionA);

        expect(sessionB).not.toHaveBeenCalled();
        expect(sessionA).toHaveBeenCalledExactlyOnceWith(command);
    });
});

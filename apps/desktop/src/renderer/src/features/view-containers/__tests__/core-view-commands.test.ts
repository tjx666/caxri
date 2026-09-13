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

    it('evicts the oldest pending view key once the pending-key cap is reached', () => {
        const first = {
            arguments: [],
            commandId: 'workbench.example.search',
            contextKey: 'session-oldest:project-a',
            role: 'resource.search' as const,
            viewId: 'workbench.example.view',
        };
        dispatchCoreViewCommand(first);
        for (let index = 0; index < 64; index += 1) {
            dispatchCoreViewCommand({
                ...first,
                contextKey: `session-cap-${index}:project-a`,
            });
        }
        const oldest = vi.fn();
        const newest = vi.fn();
        subscribeCoreViewCommands(first.viewId, first.contextKey, oldest);
        subscribeCoreViewCommands(first.viewId, 'session-cap-63:project-a', newest);
        expect(oldest).not.toHaveBeenCalled();
        expect(newest).toHaveBeenCalledExactlyOnceWith({
            ...first,
            contextKey: 'session-cap-63:project-a',
        });
    });
});

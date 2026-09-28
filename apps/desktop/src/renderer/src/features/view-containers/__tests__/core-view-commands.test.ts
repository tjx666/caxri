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
            commandId: 'workbench.example.refresh',
            contextKey: 'session-a:project-a',
            role: 'resource.refresh' as const,
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

    it('delivers a live command to a later subscriber when an earlier one throws', () => {
        const command = {
            arguments: [],
            commandId: 'workbench.example.refresh',
            contextKey: 'session-a:project-a',
            role: 'resource.refresh' as const,
            viewId: 'workbench.example.view',
        };
        const failing = vi.fn(() => {
            throw new Error('core view command listener failure');
        });
        const surviving = vi.fn();
        subscribeCoreViewCommands(command.viewId, command.contextKey, failing);
        subscribeCoreViewCommands(command.viewId, command.contextKey, surviving);
        vi.spyOn(console, 'error').mockImplementation(() => {});

        dispatchCoreViewCommand(command);

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledExactlyOnceWith(command);
        vi.restoreAllMocks();
    });

    it('evicts the oldest pending view key once the pending-key cap is reached', () => {
        const first = {
            arguments: [],
            commandId: 'workbench.example.refresh',
            contextKey: 'session-oldest:project-a',
            role: 'resource.refresh' as const,
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

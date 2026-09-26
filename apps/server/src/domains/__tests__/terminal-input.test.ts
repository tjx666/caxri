import { describe, expect, it, vi } from 'vitest';

import { TerminalManager } from '../terminal';
import {
    createTerminalAgentExactInputHandler,
    createTerminalInputHandler,
} from '../terminal-input';

describe('Agent-exact Terminal input', () => {
    it('rejects guarded review input after its Agent exits without writing to the shell', async () => {
        const writeAcknowledged = vi.fn();
        const writeAgentExact = vi.fn();
        const handler = createTerminalInputHandler({
            coordinator: { observeInput: vi.fn() } as never,
            database: { getTerminal: () => ({ provider: 'codex' }) } as never,
            send: vi.fn(),
            terminals: { agentLaunchId: () => {}, writeAcknowledged, writeAgentExact } as never,
        });
        await expect(
            handler({ terminalId: 'terminal-1', data: 'review\r', requireRunningAgent: true }),
        ).rejects.toThrow('Managed Agent is no longer running');
        expect(writeAcknowledged).not.toHaveBeenCalled();
        expect(writeAgentExact).not.toHaveBeenCalled();
    });

    it('fences guarded review input to the current Agent launch', async () => {
        const writeAgentExact = vi.fn(() => true);
        const writeAcknowledged = vi.fn();
        const handler = createTerminalInputHandler({
            coordinator: { observeInput: vi.fn(() => false) } as never,
            database: { getTerminal: () => ({ provider: 'codex' }) } as never,
            send: vi.fn(),
            terminals: {
                agentLaunchId: () => 'launch-1',
                processId: () => {},
                writeAcknowledged,
                writeAgentExact,
            } as never,
        });
        await handler({ terminalId: 'terminal-1', data: 'review\r', requireRunningAgent: true });
        expect(writeAgentExact).toHaveBeenCalledWith('terminal-1', 'review\r', 'launch-1');
        expect(writeAcknowledged).not.toHaveBeenCalled();
    });

    it('delegates the Agent launch fence to the execution boundary', () => {
        const writeAgentExact = vi.fn(
            (_terminalId: string, _data: string, expectedLaunchId: string) =>
                expectedLaunchId === 'launch-1',
        );
        const execution = { writeAgentExact };
        const observeUserInput = vi.fn();
        const manager = { execution, observeUserInput } as unknown as TerminalManager;

        expect(
            TerminalManager.prototype.writeAgentExact.call(
                manager,
                'terminal-1',
                'safe',
                'launch-old',
            ),
        ).toBe(false);
        expect(
            TerminalManager.prototype.writeAgentExact.call(
                manager,
                'terminal-1',
                'safe',
                'launch-1',
            ),
        ).toBe(true);
        expect(writeAgentExact).toHaveBeenLastCalledWith(
            'terminal-1',
            'safe',
            'launch-1',
            undefined,
            undefined,
        );
        expect(observeUserInput).toHaveBeenCalledTimes(2);
        expect(observeUserInput).toHaveBeenLastCalledWith('terminal-1', 'safe');

        observeUserInput.mockClear();
        expect(
            TerminalManager.prototype.writeAgentExact.call(
                manager,
                'terminal-1',
                'delegated',
                'launch-1',
                'delegation',
            ),
        ).toBe(true);
        expect(observeUserInput).not.toHaveBeenCalled();
        expect(writeAgentExact).toHaveBeenLastCalledWith(
            'terminal-1',
            'delegated',
            'launch-1',
            undefined,
            undefined,
        );
    });

    it('rejects the request when the target Agent generation changed', () => {
        const writeAgentExact = vi.fn(() => false);
        const handler = createTerminalAgentExactInputHandler({
            coordinator: {} as never,
            database: { getTerminal: () => ({ provider: 'codex' }) } as never,
            send: vi.fn(),
            terminals: { writeAgentExact } as never,
        });

        expect(() =>
            handler({
                terminalId: 'terminal-1',
                data: 'summary reference',
                expectedAgentLaunchId: 'launch-1',
            }),
        ).toThrow('Managed Agent changed before long paste insertion');
        expect(writeAgentExact).toHaveBeenCalledWith('terminal-1', 'summary reference', 'launch-1');
    });
});

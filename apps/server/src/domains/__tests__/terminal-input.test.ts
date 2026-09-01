import { describe, expect, it, vi } from 'vitest';

import { TerminalManager } from '../terminal';
import { createTerminalAgentExactInputHandler } from '../terminal-input';

describe('Agent-exact Terminal input', () => {
    it('delegates the Agent launch fence to the execution boundary', () => {
        const writeAgentExact = vi.fn(
            (_terminalId: string, _data: string, expectedLaunchId: string) =>
                expectedLaunchId === 'launch-1',
        );
        const execution = { writeAgentExact };
        const manager = { execution } as unknown as TerminalManager;

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
        expect(writeAgentExact).toHaveBeenLastCalledWith('terminal-1', 'safe', 'launch-1');
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

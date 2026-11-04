import { describe, expect, it } from 'vitest';

import { DELEGATION_COMMANDS } from '../delegation';

const command = DELEGATION_COMMANDS.find((item) => item.method === 'agent.delegation.redirect')!;

describe('agent delegate redirect', () => {
    it('is registered under agent delegate with an owner confirmation', () => {
        expect(command.path).toEqual(['agent', 'delegate', 'redirect']);
        expect(command.quietIdKey).toBe('delegationId');
        expect(command.ownerConfirmation).toBe('Redirect this delegated task?');
    });

    it('keeps an explicit operation ID and generates a distinct one otherwise', async () => {
        expect(
            await command.parseParams([
                'task-1',
                '--text',
                ' Use fixtures ',
                '--operation-id',
                'op-12345',
            ]),
        ).toEqual({ delegationId: 'task-1', operationId: 'op-12345', text: 'Use fixtures' });
        const first = (await command.parseParams(['task-1', '--text', 'x'])) as {
            operationId: string;
        };
        const second = (await command.parseParams(['task-1', '--text', 'x'])) as {
            operationId: string;
        };
        expect(first.operationId).not.toBe(second.operationId);
    });

    it('rejects a missing, duplicated, or conflicting argument', async () => {
        await expect(command.parseParams([])).rejects.toThrow('Expected one delegation ID');
        await expect(command.parseParams(['task-1'])).rejects.toThrow(/exactly one of/u);
        await expect(
            command.parseParams(['task-1', '--text', 'a', '--prompt-file', 'b']),
        ).rejects.toThrow(/exactly one of/u);
        await expect(command.parseParams(['task-1', '--text', 'a', '--text', 'b'])).rejects.toThrow(
            /unique/u,
        );
        await expect(command.parseParams(['task-1', '--text', 'a'.repeat(4097)])).rejects.toThrow();
        await expect(
            command.parseParams(['task-1', '--text', 'a', '--operation-id', 'x']),
        ).rejects.toThrow();
    });
});

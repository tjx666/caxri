import { describe, expect, it } from 'vitest';

import { DELEGATION_COMMANDS } from '../commands';

const command = DELEGATION_COMMANDS.find((item) => item.method === 'agent.delegation.handBack')!;

describe('agent delegate hand-back', () => {
    it('is an owner-only command under agent delegate that asks for confirmation', () => {
        expect(command.path).toEqual(['agent', 'delegate', 'hand-back']);
        expect(command.requiresHumanOwner).toBe(true);
        expect(command.quietIdKey).toBe('grantId');
        expect(command.confirmation).toBe('Hand this Session back to the Agent that delegated it?');
    });

    it('takes exactly one task ID', () => {
        expect(command.parseParams(['task-1'])).toEqual({ delegationId: 'task-1' });
        expect(() => command.parseParams([])).toThrow('Expected one delegation ID');
        expect(() => command.parseParams(['--json'])).toThrow('Expected one delegation ID');
        expect(() => command.parseParams(['task-1', 'task-2'])).toThrow(
            'Expected one delegation ID',
        );
    });
});

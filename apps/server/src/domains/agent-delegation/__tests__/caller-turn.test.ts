import { describe, expect, it, vi } from 'vitest';

import { delegatedFixture } from './delegated-sessions.fixture';

describe('the caller turn of a delegation', () => {
    it('records the turn the caller Chat was in when it created the task', async () => {
        const callerTurnId = vi.fn<(terminalId: string) => string | undefined>(() => 'turn-7');
        const f = await delegatedFixture({ callerTurnId });
        const task = await f.delegate();

        expect(callerTurnId).toHaveBeenCalledWith(f.authority.callerTerminalId);
        expect(f.database.agentDelegations.get(task.id)?.callerTurnId).toBe('turn-7');
        expect(
            f.database.agentDelegations
                .forCallerTurn(f.authority.callerTerminalId, 'turn-7')
                .map(({ receipt }) => receipt.delegationId),
        ).toEqual([task.id]);
        expect(
            f.database.agentDelegations.forCallerTurn(f.authority.callerTerminalId, 'turn-8'),
        ).toEqual([]);
    });

    it('records nothing for a caller that is not a Chat or is between turns', async () => {
        const f = await delegatedFixture({ callerTurnId: () => {} });
        const task = await f.delegate();

        expect(f.database.agentDelegations.get(task.id)).not.toHaveProperty('callerTurnId');
    });
});

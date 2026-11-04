import type { CaxriError } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { approvalFixture, command } from './approvals.fixture';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

const refusal = (run: () => unknown) => {
    try {
        run();
    } catch (error) {
        return error as CaxriError;
    }
    throw new Error('expected the call to refuse');
};

describe('answer-time revalidation', () => {
    it('refuses a request whose delegated Chat was relaunched', async () => {
        const f = await approvalFixture();
        f.ask(command());

        f.launches.set(f.child, 'relaunched');

        expect(refusal(() => f.decide('req-1')).code).toBe('CONFLICT');
        expect(f.provider.responses).toEqual([]);
        expect(f.approvals.viewFor(f.task.id)).toBeUndefined();
    });

    it('refuses a request that outlived the turn it was asked in', async () => {
        const f = await approvalFixture();
        f.ask(command());

        f.provider.activeTurnId = 'turn-2';

        expect(refusal(() => f.decide('req-1')).code).toBe('CONFLICT');
        expect(f.provider.responses).toEqual([]);
        expect(f.approvals.viewFor(f.task.id)).toBeUndefined();
    });

    it('drops every request when the provider restarts', async () => {
        const f = await approvalFixture();
        f.ask(command());

        f.approvals.reset();

        expect(f.approvals.viewFor(f.task.id)).toBeUndefined();
        expect(refusal(() => f.decide('req-1')).code).toBe('NOT_FOUND');
        expect(f.provider.responses).toEqual([]);
    });

    it('does not let the delegating Agent approve once a person typed in the delegated Chat', async () => {
        const f = await approvalFixture();
        f.ask(command());

        f.service.interruptTerminal(f.child, true);

        expect(refusal(() => f.decide('req-1')).code).toBe('NOT_FOUND');
        expect(f.provider.responses).toEqual([]);
    });
});

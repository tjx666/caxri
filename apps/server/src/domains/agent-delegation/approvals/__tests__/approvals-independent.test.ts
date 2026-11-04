import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { approvalFixture, command } from './approvals.fixture';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('a request of an independent Session', () => {
    it('is shown to the user at once and never held for the Agent that started the Session', async () => {
        const f = await approvalFixture({}, { flags: { independent: true } });

        expect(f.ask(command())).toBe('alert');

        expect(f.approvals.viewFor(f.task.id)).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('is still held for the delegating Agent in an ordinary delegated Session', async () => {
        const f = await approvalFixture();

        expect(f.ask(command())).toBe('quiet');
    });
});

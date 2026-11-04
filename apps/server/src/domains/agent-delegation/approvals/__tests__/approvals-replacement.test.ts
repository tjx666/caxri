import type { CaxriError } from '@caxri/protocol';
import { APPROVAL_ESCALATION_GRACE_MS } from '@caxri/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileChange } from './approvals.fixture';
import { approvalFixture, command } from './approvals.fixture';

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

const fileChange = (paths: string[], id = 'req-1'): FileChange => ({
    id,
    kind: 'fileChange',
    paths,
});

const refusal = (run: () => unknown) => {
    try {
        run();
    } catch (error) {
        return error as CaxriError;
    }
    throw new Error('expected a refusal');
};

describe('a request the provider replaces under the same id', () => {
    it('is not approved by a decision bound to the version the delegating Agent read', async () => {
        const f = await approvalFixture();
        f.ask(command('req-1', { command: 'echo A' }));
        const read = f.approvals.viewFor(f.task.id)!;
        expect(read.revision).toEqual(expect.any(String));

        // The provider overwrites the request in place and the Chat projection changes; no second attention signal.
        f.provider.requests = [command('req-1', { command: 'rm -rf B' })];
        f.approvals.observe(f.child);
        const reread = f.approvals.viewFor(f.task.id)!;
        expect(reread.command).toBe('rm -rf B');
        expect(reread.revision).not.toBe(read.revision);

        const error = refusal(() => f.decide('req-1', 'accept', undefined, read.revision));
        expect(error.code).toBe('CONFLICT');
        expect(error.details).toEqual({ conflictReason: 'request_changed' });
        expect(f.provider.responses).toEqual([]);

        expect(f.decide('req-1', 'accept', undefined, reread.revision)).toEqual({
            outcome: 'approved',
        });
        expect(f.provider.responses).toEqual([{ requestId: 'req-1', decision: 'accept' }]);
    });

    it('keeps the same revision while the request is unchanged', async () => {
        const f = await approvalFixture();
        f.ask(command());
        const first = f.approvals.viewFor(f.task.id)!.revision;
        f.approvals.observe(f.child);
        expect(f.approvals.viewFor(f.task.id)!.revision).toBe(first);
    });

    it('stays approvable once its new path is proven, though it had escalated', async () => {
        let isGated = false;
        const gate = Promise.withResolvers<void>();
        const f = await approvalFixture(
            {},
            {
                pathResolver: async (_id, path) => {
                    if (isGated) await gate.promise;
                    return { root: '/workspace', workspacePath: path };
                },
            },
        );
        f.ask(fileChange(['/workspace/a.ts']));
        await vi.advanceTimersByTimeAsync(0);
        f.elapse(APPROVAL_ESCALATION_GRACE_MS);
        expect(f.approvals.viewFor(f.task.id)).toMatchObject({ escalated: true, covered: true });

        isGated = true;
        f.provider.requests = [fileChange(['/workspace/b.ts'])];
        f.approvals.observe(f.child);
        expect(f.approvals.viewFor(f.task.id)).toBeUndefined();

        gate.resolve();
        await vi.advanceTimersByTimeAsync(0);

        const view = f.approvals.viewFor(f.task.id);
        expect(view).toMatchObject({ escalated: true, paths: ['/workspace/b.ts'] });
        expect(f.decide('req-1', 'accept', undefined, view!.revision)).toEqual({
            outcome: 'approved',
        });
    });
});

describe('a path verdict that arrives after the first refresh', () => {
    it('emits a content-free change so the feed re-reads the approval', async () => {
        const gate = Promise.withResolvers<void>();
        const f = await approvalFixture(
            {},
            {
                pathResolver: async (_id, path) => (
                    await gate.promise,
                    { root: '/workspace', workspacePath: path }
                ),
            },
        );
        f.ask(fileChange(['/workspace/a.ts']));
        expect(f.provider.changes.map((change) => change.state)).toEqual(['pending']);

        gate.resolve();
        await vi.advanceTimersByTimeAsync(0);

        expect(f.provider.changes.map((change) => change.state)).toEqual(['pending', 'pending']);
        expect(Object.keys(f.provider.changes[1]).toSorted((a, b) => a.localeCompare(b))).toEqual([
            'delegationId',
            'requestId',
            'sessionId',
            'state',
        ]);
    });
});

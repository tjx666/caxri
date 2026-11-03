import { randomUUID } from 'node:crypto';

import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { delegatedFixture } from './delegated-sessions.fixture';

/**
 * A fixture whose Server logs into a mock, with the fields of every entry of one event.
 */
async function loggedFixture(overrides: Parameters<typeof delegatedFixture>[0] = {}) {
    const write = vi.fn<StructuredLogger['write']>();
    const f = await delegatedFixture({
        logger: { write } as unknown as StructuredLogger,
        ...overrides,
    });
    const entries = (event: string) =>
        write.mock.calls.filter((call) => call[1] === event).map((call) => call[2]?.fields);
    return { ...f, entries };
}

describe('agent_delegation.requested', () => {
    it.each([
        [{}, 'delegated'],
        [{ consult: true as const }, 'consult'],
        [{ handoff: true as const }, 'handoff'],
    ])('names how the Session was started (%o -> %s)', async (flags, relation) => {
        const f = await loggedFixture();

        const task = await f.delegate(flags);

        expect(f.entries('agent_delegation.requested')).toEqual([
            expect.objectContaining({ delegationId: task.id, relation }),
        ]);
    });

    it('reports none for a Session with no creator relation', async () => {
        const f = await loggedFixture();
        const ordinary = f.database.createSession(f.project.id, null).session;
        const owner = { principal: { kind: 'human-cli' as const, id: 'owner', generation: 1 } };

        await f.service.create(randomUUID(), owner, {
            projectId: f.project.id,
            sessionId: ordinary.id,
            provider: 'claude',
            prompt: 'Synthetic ordinary task',
        });

        expect(f.entries('agent_delegation.requested')).toEqual([
            expect.objectContaining({ relation: 'none' }),
        ]);
    });
});

describe('agent_delegation.transitioned', () => {
    it.each([
        ['billing_error', 'quota_exhausted', 61_000, true],
        ['billing_error', 'quota_exhausted', undefined, false],
        ['rate_limit', 'rate_limited', 61_000, true],
        ['rate_limit', 'rate_limited', undefined, false],
    ] as const)(
        'says whether a %s failure knew its reset time (%s, reset %s -> %s)',
        async (agentFailure, failure, resetsAt, hasFailureResetsAt) => {
            const f = await loggedFixture({ limitResetsAt: () => resetsAt });
            const task = await f.delegate();
            const signal = f.start(task);

            f.service.observe({ ...signal, phase: 'turnFailed', agentFailure });

            expect(f.entries('agent_delegation.transitioned').at(-1)).toMatchObject({
                status: 'failed',
                failure,
                hasFailureResetsAt,
            });
        },
    );

    it('leaves the flag out of every other transition', async () => {
        const f = await loggedFixture();
        const task = await f.delegate();
        const signal = f.start(task);
        f.service.observe({ ...signal, phase: 'turnFailed', agentFailure: 'provider_failed' });

        const transitions = f.entries('agent_delegation.transitioned');

        expect(transitions.at(-1)).toMatchObject({ failure: 'provider_failed' });
        for (const fields of transitions) expect(fields).not.toHaveProperty('hasFailureResetsAt');
    });
});

describe('agent_delegation.result_recorded', () => {
    it('records a stored result with where its summary came from and the time since the task was created', async () => {
        const f = await loggedFixture();
        const authored = await f.delegate();
        const createdAt = f.state.clock;

        await f.finish(authored, 'Looked.\nSummary: Private authored words.');

        expect(f.entries('agent_delegation.result_recorded')).toEqual([
            {
                delegationId: authored.id,
                sessionId: authored.receipt.sessionId,
                outcome: 'stored',
                summarySource: 'authored',
                durationMs: f.state.clock - createdAt,
            },
        ]);
    });

    it('records an excerpt, and no_summary for an answer with nothing to summarize', async () => {
        const f = await loggedFixture();
        const excerpt = await f.delegate({ consult: true });
        await f.finish(excerpt, 'Private excerpt words.');
        const empty = await f.delegate();
        await f.finish(empty, '# Only a heading');

        expect(f.entries('agent_delegation.result_recorded')).toMatchObject([
            { delegationId: excerpt.id, outcome: 'stored', summarySource: 'excerpt' },
            { delegationId: empty.id, outcome: 'no_summary', summarySource: null },
        ]);
    });

    it('records nothing for a hand-off, and never carries the summary or the answer', async () => {
        const f = await loggedFixture();
        const handoff = await f.delegate({ handoff: true });
        await f.finish(handoff, 'Summary: Private handoff words.');
        const delegated = await f.delegate();
        await f.finish(delegated, 'Summary: Private delegated words.');

        const entries = f.entries('agent_delegation.result_recorded');

        expect(entries).toHaveLength(1);
        expect(JSON.stringify(entries)).not.toContain('Private');
    });
});

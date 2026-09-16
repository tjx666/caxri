import { describe, expect, it } from 'vitest';

import { LinearIssueStore } from '../linear';

const ISSUE_RESPONSE = JSON.stringify({
    data: {
        issue: {
            identifier: 'ABC-42',
            title: 'Router monitoring',
            url: 'https://linear.app/acme/issue/ABC-42',
            state: { name: 'In Progress', type: 'started', color: '#5E6AD2' },
        },
    },
});

const TEAM_KEYS_RESPONSE = JSON.stringify({
    data: { teams: { nodes: [{ key: 'ABC' }, { key: 'xyz' }] } },
});

function harness(responses: () => Promise<string>) {
    const calls: string[][] = [];
    let now = 1_000;
    const store = new LinearIssueStore(
        async (arguments_) => {
            calls.push([...arguments_]);
            return responses();
        },
        { now: () => now },
    );
    return { calls, store, advance: (ms: number) => (now += ms) };
}

describe('Linear issue store', () => {
    it('serves a repeated lookup from one CLI spawn and refetches after the TTL', async () => {
        const { calls, store, advance } = harness(() => Promise.resolve(ISSUE_RESPONSE));
        const first = await store.issue({ cwd: '/repo', identifier: 'abc-42' });
        expect(first).toMatchObject({ identifier: 'ABC-42', state: 'In Progress' });
        await store.issue({ cwd: '/repo', identifier: 'ABC-42' });
        expect(calls).toHaveLength(1);
        advance(90_001);
        await store.issue({ cwd: '/repo', identifier: 'ABC-42' });
        expect(calls).toHaveLength(2);
    });

    it('refetches immediately when the caller demands a fresh read', async () => {
        const { calls, store } = harness(() => Promise.resolve(ISSUE_RESPONSE));
        await store.issue({ cwd: '/repo', identifier: 'ABC-42' });
        await store.issue({ cwd: '/repo', identifier: 'ABC-42', maxAgeMs: 0 });
        expect(calls).toHaveLength(2);
    });

    it('remembers a failure so a missing CLI is not respawned on every poll', async () => {
        const { calls, store, advance } = harness(() =>
            Promise.reject(new Error('linear: not found')),
        );
        await expect(store.issue({ cwd: '/repo', identifier: 'ABC-42' })).rejects.toThrow(
            'linear: not found',
        );
        await expect(store.issue({ cwd: '/repo', identifier: 'ABC-42' })).rejects.toThrow(
            'linear: not found',
        );
        expect(calls).toHaveLength(1);
        advance(60_001);
        await expect(store.issue({ cwd: '/repo', identifier: 'ABC-42' })).rejects.toThrow();
        expect(calls).toHaveLength(2);
    });

    it('resolves the team-key allow-list once per workspace, upper-cased', async () => {
        const { calls, store } = harness(() => Promise.resolve(TEAM_KEYS_RESPONSE));
        expect([...(await store.allowedTeamKeys('/repo'))]).toEqual(['ABC', 'XYZ']);
        await store.allowedTeamKeys('/repo');
        expect(calls).toHaveLength(1);
    });

    it('answers an unavailable allow-list with an empty set instead of an error', async () => {
        const { calls, store, advance } = harness(() =>
            Promise.reject(new Error('no credentials')),
        );
        expect((await store.allowedTeamKeys('/repo')).size).toBe(0);
        await store.allowedTeamKeys('/repo');
        expect(calls).toHaveLength(1);
        // A failed allow-list retries far sooner than a successful one, so authenticating fixes the chip in minutes.
        advance(5 * 60_000 + 1);
        await store.allowedTeamKeys('/repo');
        expect(calls).toHaveLength(2);
    });

    it('keeps issues from different workspaces apart', async () => {
        const { calls, store } = harness(() => Promise.resolve(ISSUE_RESPONSE));
        await store.issue({ cwd: '/repo', identifier: 'ABC-42' });
        await store.issue({ cwd: '/repo', identifier: 'ABC-42', workspace: 'acme' });
        expect(calls).toHaveLength(2);
        expect(calls[1]).toContain('--workspace');
    });
});

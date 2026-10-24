import { describe, expect, it, vi } from 'vitest';

import {
    createdPullRequestLines,
    harness,
    pullRequestJson,
    session,
} from './session-pull-requests.fixture';

/**
 * A pull request link the Agent merely wrote in its prose, as opposed to one its own `gh pr create` returned.
 */
describe('SessionPullRequestService mentioned pull requests', () => {
    it('trusts a merely mentioned PR link only for the Session repository', async () => {
        const gh = vi.fn((arguments_: readonly string[]) => {
            if (arguments_[1] === 'view') return Promise.resolve(pullRequestJson({ number: 7 }));
            return Promise.resolve('[]');
        });
        const mention = (url: string): string =>
            JSON.stringify({
                type: 'assistant',
                message: { content: [{ type: 'text', text: `See ${url}.` }] },
            });
        const { service, setTranscript } = await harness({ gh });
        await setTranscript([mention('https://github.com/stranger/repo/pull/7')]);
        await service.refresh();
        expect(gh.mock.calls.map(([arguments_]) => arguments_[1])).toEqual(['list']);
        expect(service.snapshot().pullRequests['session-1']).toBeUndefined();

        await setTranscript([
            mention('https://github.com/stranger/repo/pull/7'),
            mention('https://github.com/example/example/pull/7'),
        ]);
        await service.refresh();
        expect(service.snapshot().pullRequests['session-1']).toMatchObject({
            number: 7,
            source: 'agent',
        });
    });

    it('ignores a mentioned PR that merged before the Session existed, but keeps a created one', async () => {
        const createdAt = Date.parse('2026-10-23T00:00:00Z');
        const gh = vi.fn((arguments_: readonly string[]) => {
            if (arguments_[1] === 'view')
                return Promise.resolve(
                    pullRequestJson({ number: 7, mergedAt: '2026-10-19T06:11:53Z' }),
                );
            return Promise.resolve('[]');
        });
        const { service, setTranscript } = await harness({
            gh,
            sessions: [session({ createdAt, primaryAgentTerminalId: 'terminal-1' })],
        });
        const mention = JSON.stringify({
            type: 'assistant',
            message: {
                content: [
                    { type: 'text', text: 'Related: https://github.com/example/example/pull/7.' },
                ],
            },
        });
        await setTranscript([mention]);
        await service.refreshSession('session-1');
        expect(service.snapshot().pullRequests['session-1']).toBeUndefined();
        expect(gh.mock.calls.map(([arguments_]) => arguments_[1])).toEqual(['view', 'list']);

        await setTranscript([mention, ...createdPullRequestLines]);
        await service.refreshSession('session-1');
        expect(service.snapshot().pullRequests['session-1']).toMatchObject({
            number: 7,
            state: 'merged',
        });
    });
});

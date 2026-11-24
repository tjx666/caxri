import { describe, expect, it } from 'vitest';

import { parseSessionPullRequest } from '../session-pull-request-parse';
import { harness, pullRequestJson } from './session-pull-requests.fixture';

describe('SessionPullRequest changedFiles', () => {
    it('is the whole pull request file count, and is omitted when unknown or zero', () => {
        const parse = (overrides: Record<string, unknown>) =>
            parseSessionPullRequest(pullRequestJson(overrides), 'agent', []);

        expect(parse({ changedFiles: 7 })?.changedFiles).toBe(7);
        expect(parse({})).not.toHaveProperty('changedFiles');
        expect(parse({ changedFiles: 0 })).not.toHaveProperty('changedFiles');
    });

    it('carries closedAt for a closed pull request and omits it while open', () => {
        const parse = (overrides: Record<string, unknown>) =>
            parseSessionPullRequest(pullRequestJson(overrides), 'agent', []);
        const closedAt = '2026-10-19T06:11:53Z';

        expect(parse({ state: 'CLOSED', closedAt })?.closedAt).toBe(Date.parse(closedAt));
        expect(parse({ state: 'OPEN', closedAt: null })).not.toHaveProperty('closedAt');
    });

    it('emits a change when only the file count moves', async () => {
        let changedFiles = 3;
        const clock = { now: 0 };
        const { emitted, service } = await harness({
            now: () => clock.now,
            gh: (arguments_) =>
                Promise.resolve(
                    arguments_[1] === 'list'
                        ? JSON.stringify([{ number: 19_024, state: 'OPEN' }])
                        : pullRequestJson({ state: 'OPEN', changedFiles }),
                ),
        });

        await service.refresh();
        clock.now += 120_000;
        await service.refresh();
        expect(emitted).toHaveLength(1);
        expect(service.snapshot().pullRequests['session-1']).toMatchObject({ changedFiles: 3 });

        changedFiles = 5;
        clock.now += 120_000;
        await service.refresh();

        expect(emitted).toHaveLength(2);
        expect(service.snapshot().pullRequests['session-1']).toMatchObject({ changedFiles: 5 });
    });
});

import type { SessionPullRequest } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { PullRequestSettlement } from '../settlement';
import { PullRequestSettlementWiring } from '../settlement-wiring';

function pullRequest(state: SessionPullRequest['state']): SessionPullRequest {
    return { state, url: 'https://github.com/example/example/pull/1' } as SessionPullRequest;
}

describe('PullRequestSettlementWiring', () => {
    it("tracks each Session's latest pull request state and forwards every change", () => {
        const wiring = new PullRequestSettlementWiring(() => {});
        const observePullRequest = vi.fn();
        wiring.attach({ observePullRequest } as unknown as PullRequestSettlement);
        expect(wiring.pullRequestState('session')).toBeUndefined();

        wiring.observePullRequest('session', undefined, pullRequest('open'));
        expect(wiring.pullRequestState('session')).toBe('open');
        wiring.observePullRequest('session', pullRequest('open'), pullRequest('merged'));
        expect(wiring.pullRequestState('session')).toBe('merged');
        expect(observePullRequest).toHaveBeenCalledTimes(2);

        wiring.observePullRequest('session', pullRequest('merged'), undefined);
        expect(wiring.pullRequestState('session')).toBeUndefined();
    });

    it('drops the state of a forgotten Session', () => {
        const wiring = new PullRequestSettlementWiring(() => {});
        wiring.observePullRequest('session', undefined, pullRequest('merged'));
        wiring.forgetSession('session');
        expect(wiring.pullRequestState('session')).toBeUndefined();
    });
});

import type { SessionPullRequest } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { PullRequestSettlement } from '../settlement';
import { PullRequestSettlementWiring } from '../settlement-wiring';

function pullRequest(state: SessionPullRequest['state']): SessionPullRequest {
    return { state, url: 'https://github.com/example/example/pull/1' } as SessionPullRequest;
}

describe('PullRequestSettlementWiring', () => {
    it("tracks each Session's latest pull request and forwards every change", () => {
        const wiring = new PullRequestSettlementWiring(() => {});
        const observePullRequest = vi.fn();
        wiring.attach({ observePullRequest } as unknown as PullRequestSettlement);
        expect(wiring.pullRequest('session')).toBeUndefined();

        wiring.observePullRequest('session', undefined, pullRequest('open'));
        expect(wiring.pullRequest('session')?.state).toBe('open');
        wiring.observePullRequest('session', pullRequest('open'), pullRequest('merged'));
        expect(wiring.pullRequest('session')?.state).toBe('merged');
        expect(observePullRequest).toHaveBeenCalledTimes(2);

        wiring.observePullRequest('session', pullRequest('merged'), undefined);
        expect(wiring.pullRequest('session')).toBeUndefined();
    });

    it('drops the pull request of a forgotten Session', () => {
        const wiring = new PullRequestSettlementWiring(() => {});
        wiring.observePullRequest('session', undefined, pullRequest('merged'));
        wiring.forgetSession('session');
        expect(wiring.pullRequest('session')).toBeUndefined();
    });
});

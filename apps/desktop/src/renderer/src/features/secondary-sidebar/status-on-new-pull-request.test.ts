import type { SessionPullRequests } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    isNewSessionPullRequest,
    selectPullRequestUrl,
    shouldSwitchToStatusForNewPullRequest,
} from './status-on-new-pull-request';

const PR_534 = 'https://github.com/example/repo/pull/534';
const PR_535 = 'https://github.com/example/repo/pull/535';

function snapshot(pullRequests: SessionPullRequests['pullRequests']): SessionPullRequests {
    return { pullRequests, refreshedAt: 1 };
}

describe('selectPullRequestUrl', () => {
    it('keeps an unloaded snapshot apart from a Session without a pull request', () => {
        expect(selectPullRequestUrl(undefined, 's1')).toBeUndefined();
        expect(selectPullRequestUrl(snapshot({}), undefined)).toBeUndefined();
        expect(selectPullRequestUrl(snapshot({}), 's1')).toBeNull();
    });

    it('returns the selected Session’s pull request URL', () => {
        const pullRequest = {
            number: 534,
            source: 'agent',
            state: 'open',
            title: 'Docs',
            url: PR_534,
        };
        expect(
            selectPullRequestUrl(
                snapshot({ s1: pullRequest as SessionPullRequests['pullRequests'][string] }),
                's1',
            ),
        ).toBe(PR_534);
    });
});

describe('isNewSessionPullRequest', () => {
    it('treats the first observation as a baseline, even when a pull request already exists', () => {
        expect(isNewSessionPullRequest(undefined, { sessionId: 's1', url: PR_534 })).toBe(false);
    });

    it('detects a pull request the Session opened after the baseline', () => {
        expect(
            isNewSessionPullRequest(
                { sessionId: 's1', url: null },
                { sessionId: 's1', url: PR_534 },
            ),
        ).toBe(true);
    });

    it('detects a different pull request replacing the previous one', () => {
        expect(
            isNewSessionPullRequest(
                { sessionId: 's1', url: PR_534 },
                { sessionId: 's1', url: PR_535 },
            ),
        ).toBe(true);
    });

    it('ignores updates to the same pull request and its disappearance', () => {
        expect(
            isNewSessionPullRequest(
                { sessionId: 's1', url: PR_534 },
                { sessionId: 's1', url: PR_534 },
            ),
        ).toBe(false);
        expect(
            isNewSessionPullRequest(
                { sessionId: 's1', url: PR_534 },
                { sessionId: 's1', url: null },
            ),
        ).toBe(false);
    });

    it('treats selecting another Session as a new baseline', () => {
        expect(
            isNewSessionPullRequest(
                { sessionId: 's1', url: null },
                { sessionId: 's2', url: PR_534 },
            ),
        ).toBe(false);
    });
});

describe('shouldSwitchToStatusForNewPullRequest', () => {
    it('switches only away from Source Control', () => {
        expect(shouldSwitchToStatusForNewPullRequest('caxri.git')).toBe(true);
    });

    it('keeps the tab the user chose', () => {
        expect(shouldSwitchToStatusForNewPullRequest('caxri.files')).toBe(false);
        expect(shouldSwitchToStatusForNewPullRequest('caxri.project-status')).toBe(false);
        expect(shouldSwitchToStatusForNewPullRequest(undefined)).toBe(false);
    });
});

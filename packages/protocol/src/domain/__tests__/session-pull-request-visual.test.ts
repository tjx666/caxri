import { describe, expect, it } from 'vitest';

import { sessionAttentionVariant } from '../session/session-activity-group.js';
import { sessionPullRequestVisual } from '../session-pull-request.js';

describe('sessionPullRequestVisual', () => {
    it('keeps lifecycle in the color and shape', () => {
        expect(sessionPullRequestVisual({ state: 'open' })).toEqual({
            icon: 'open',
            tone: 'success',
        });
        expect(sessionPullRequestVisual({ state: 'draft' })).toEqual({
            icon: 'draft',
            tone: 'neutral',
        });
        expect(sessionPullRequestVisual({ state: 'closed' })).toEqual({
            icon: 'closed',
            tone: 'danger',
        });
        expect(sessionPullRequestVisual({ state: 'merged' })).toEqual({
            icon: 'merged',
            tone: 'merged',
        });
    });

    it('turns a merged pull request into a rocket whose color follows the deployment', () => {
        const merged = (state: 'success' | 'failure' | 'pending' | 'queued' | 'cancelled') =>
            sessionPullRequestVisual({ state: 'merged', deployment: { state } });
        expect(merged('success')).toEqual({ icon: 'deployed', tone: 'merged' });
        expect(merged('failure')).toEqual({ icon: 'deployed', tone: 'danger' });
        expect(merged('pending')).toEqual({ icon: 'deployed', tone: 'warning' });
        expect(merged('queued')).toEqual({ icon: 'deployed', tone: 'warning' });
        expect(merged('cancelled')).toEqual({ icon: 'merged', tone: 'merged' });
    });
});

describe('sessionAttentionVariant', () => {
    it('separates a question for the user from a result to read', () => {
        expect(sessionAttentionVariant('waiting')).toBe('waiting');
        expect(sessionAttentionVariant('completed')).toBe('result');
        expect(sessionAttentionVariant(undefined)).toBe('result');
    });
});

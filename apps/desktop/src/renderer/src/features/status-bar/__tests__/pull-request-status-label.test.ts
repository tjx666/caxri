import { pullRequestUnavailableSchema } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { pullRequestUnavailableLabel } from '../pull-request-status-label';

const reasons = pullRequestUnavailableSchema.shape.reason.options;

describe('pull request status bar label', () => {
    it('names the condition instead of falling back to unknown', () => {
        expect(pullRequestUnavailableLabel('rate-limited')).toBe('PR rate limited');
        expect(pullRequestUnavailableLabel('not-logged-in')).toBe('PR needs login');
        expect(pullRequestUnavailableLabel('not-found')).toBe('PR needs gh');
        expect(pullRequestUnavailableLabel('not-linked')).toBe('PR needs setup');
        expect(pullRequestUnavailableLabel('timeout')).toBe('PR timed out');
    });

    /**
     * Both mean GitHub is out of reach, but the hover cards send the user to different places, so the chips must too.
     */
    it('separates a lost connection from a refused certificate', () => {
        expect(pullRequestUnavailableLabel('network')).toBe('PR offline');
        expect(pullRequestUnavailableLabel('tls')).toBe('PR TLS error');
    });

    it('keeps unknown for the reason that genuinely is unknown', () => {
        expect(pullRequestUnavailableLabel('other')).toBe('PR unknown');
    });

    /**
     * The label map is keyed by the protocol enum, so a reason added upstream must not silently render `undefined`.
     */
    it('labels every reason the protocol can send', () => {
        for (const reason of reasons) {
            const label = pullRequestUnavailableLabel(reason);
            expect(label, reason).toMatch(/^PR \S/);
        }
        expect(new Set(reasons.map((reason) => pullRequestUnavailableLabel(reason))).size).toBe(
            reasons.length,
        );
    });
});

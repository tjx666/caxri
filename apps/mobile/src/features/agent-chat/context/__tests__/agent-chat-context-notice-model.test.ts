import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    agentChatContextNotice,
    dismissAgentChatCacheNotice,
} from '../agent-chat-context-notice-model';

const MINUTE = 60_000;
const usage = {
    totalTokens: 113_000,
    contextWindow: 200_000,
    cacheTtlMinutes: 60,
    lastResponseAt: 0,
    cacheRewriteUsd: 0.69,
};

describe('agentChatContextNotice', () => {
    it('says nothing while the cache is warm and the context is small', () => {
        expect(agentChatContextNotice(usage, 30 * MINUTE, 't-quiet', translate)).toBeUndefined();
        expect(agentChatContextNotice(undefined, 0, 't-quiet', translate)).toBeUndefined();
    });

    it('counts down the last minutes of the cache with the estimated re-read', () => {
        expect(agentChatContextNotice(usage, 50 * MINUTE, 't-expiring', translate)).toEqual({
            lines: ['Reply within 10m to skip a full re-read (est. ~$0.69).'],
            tone: 'warning',
            dismissAt: 0,
        });
    });

    it('reports an expired cache as a muted cost fact', () => {
        expect(agentChatContextNotice(usage, 75 * MINUTE, 't-expired', translate)).toMatchObject({
            lines: [expect.stringContaining('Idle 1h 15m')],
            tone: 'muted',
        });
    });

    it('adds a full-context line that a cache dismissal does not hide', () => {
        const full = { ...usage, totalTokens: 180_000 };
        const before = agentChatContextNotice(full, 75 * MINUTE, 't-full', translate);
        expect(before?.lines).toHaveLength(2);
        expect(before?.tone).toBe('warning');
        dismissAgentChatCacheNotice('t-full', 0);
        const after = agentChatContextNotice(full, 75 * MINUTE, 't-full', translate);
        expect(after?.lines).toEqual([expect.stringContaining('nearly full')]);
        expect(after?.dismissAt).toBeUndefined();
    });

    it('shows the cache notice again after a newer reply', () => {
        dismissAgentChatCacheNotice('t-again', 0);
        expect(
            agentChatContextNotice(
                { ...usage, lastResponseAt: 10 * MINUTE },
                65 * MINUTE,
                't-again',
                translate,
            )?.lines,
        ).toHaveLength(1);
    });
});

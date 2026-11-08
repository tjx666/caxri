import type { AgentChatTrackerArtifact } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { trackerExcerptLabel, trackerReferenceLabel } from '../agent-chat-tracker-labels';

const artifact = (patch: Partial<AgentChatTrackerArtifact>): AgentChatTrackerArtifact =>
    ({ reference: 'ACC-1', excerpt: 'First line', ...patch }) as AgentChatTrackerArtifact;

describe('tracker card labels', () => {
    it('words the round and check count through the locale', () => {
        expect(trackerReferenceLabel(artifact({ round: 2 }), translate)).toBe('Round 2');
        expect(trackerReferenceLabel(artifact({}), translate)).toBe('ACC-1');
        expect(trackerExcerptLabel(artifact({ checks: 1 }), translate)).toBe('1 check');
        expect(trackerExcerptLabel(artifact({ checks: 3 }), translate)).toBe('3 checks');
        expect(trackerExcerptLabel(artifact({}), translate)).toBe('First line');
    });
});

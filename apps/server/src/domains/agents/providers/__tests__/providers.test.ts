import { agentProviderIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentProviders } from '..';

describe('Agent provider Runtime descriptors', () => {
    it.each(agentProviderIds)('gives %s one delegation argv renderer', (provider) => {
        const descriptor = agentProviders[provider];
        expect(
            [
                descriptor.prepareLaunch !== undefined,
                descriptor.delegation?.freshLaunch !== undefined,
            ].filter(Boolean),
        ).toHaveLength(1);
    });
    it('makes one explicit descriptor decision for every catalogued provider', () => {
        expect(new Set(Object.keys(agentProviders))).toEqual(new Set(agentProviderIds));
    });

    /**
     * Mobile cannot import Server descriptors, so `CONVERSATION_TIMELINE_PROVIDERS` in
     * `apps/mobile/src/features/sessions/session-ui-state.ts` hard-codes this set. Change both together.
     */
    it('projects a Conversation timeline for exactly the providers Mobile expects', () => {
        expect(
            new Set(
                agentProviderIds.filter(
                    (provider) => agentProviders[provider].timelineProjector !== undefined,
                ),
            ),
        ).toEqual(new Set(['claude', 'codex']));
    });

    it.each([
        ['claude', ['--resume', 'provider-session-1']],
        ['codex', ['resume', 'provider-session-1']],
        ['grok', ['--resume', 'provider-session-1']],
    ] as const)('keeps %s resume argv provider-local', (provider, expected) => {
        expect(agentProviders[provider].resumeArguments('provider-session-1')).toEqual(expected);
    });
});

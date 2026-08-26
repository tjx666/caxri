import { agentProviderIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentProviders } from '..';

describe('Agent provider Runtime descriptors', () => {
    it('makes one explicit descriptor decision for every catalogued provider', () => {
        expect(new Set(Object.keys(agentProviders))).toEqual(new Set(agentProviderIds));
    });

    it.each([
        ['claude', ['--resume', 'provider-session-1']],
        ['codex', ['resume', 'provider-session-1']],
    ] as const)('keeps %s resume argv provider-local', (provider, expected) => {
        expect(agentProviders[provider].resumeArguments('provider-session-1')).toEqual(expected);
    });
});

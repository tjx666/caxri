import type { AgentProvider } from '@caxri/protocol';
import { defaultAgentActions } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { isTranslationKey } from '../../../i18n';

describe('built-in Agent action descriptions', () => {
    it('translates every built-in command Settings lists', () => {
        const missing = Object.entries(defaultAgentActions).flatMap(([provider, actions]) =>
            actions
                .map(
                    (action) =>
                        `settings.agentActionsEditor.builtInDescription.${provider as AgentProvider}.${action.invocation}`,
                )
                .filter((key) => !isTranslationKey(key)),
        );
        expect(missing).toEqual([]);
    });
});

import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatDrivers } from '../chat-drivers';

describe('agentChatDrivers', () => {
    it.each(agentProviderIds)(
        'has a %s driver exactly when the catalog marks the provider Chat-capable',
        (provider) => {
            expect(Boolean(agentChatDrivers[provider])).toBe(
                agentProviderCatalog[provider].capabilities.chat,
            );
        },
    );
});

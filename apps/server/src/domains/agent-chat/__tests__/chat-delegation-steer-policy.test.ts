import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import { ChatDelegationLinks } from '../chat-delegation';
import type { ChatState } from '../chat-states';

vi.mock('@caxri/system', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    assertE2EAgentChatInput: () => {
        throw new CaxriError(
            'VALIDATION',
            'Real Agent Chat E2E accepts only short natural prompts',
        );
    },
}));

describe('ChatDelegationLinks.steerToLaunch under the real-Agent E2E input policy', () => {
    it('refuses a rejected text as not_steerable so the operation ID stays retryable', async () => {
        const send = vi.fn(() => Promise.resolve());
        const state = {
            launchId: 'launch',
            sendQueue: Promise.resolve(),
            followUps: { mustWait: () => true, add: vi.fn() },
            projection: { snapshot: { activeTurnId: 'turn-1' } },
            session: { isOpen: true, send },
        } as unknown as ChatState;
        const links = new ChatDelegationLinks({ state: () => state, admit: () => {} });

        await expect(
            links.steerToLaunch('terminal', 'launch', {
                turnId: 'turn-1',
                inputEpoch: 0,
                text: 'x',
            }),
        ).rejects.toMatchObject({ details: { steerRefusal: 'not_steerable' } });
        expect(send).not.toHaveBeenCalled();
    });
});

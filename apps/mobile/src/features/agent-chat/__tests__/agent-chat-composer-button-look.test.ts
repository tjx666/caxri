import { describe, expect, it } from 'vitest';

import { agentChatComposerButtonLook } from '../agent-chat-composer-button-look';

const idle = { canQueue: false, canSubmit: true, isBusy: false, isRunning: false } as const;

describe('agentChatComposerButtonLook', () => {
    it('shows the send arrow on the brand color when idle', () => {
        expect(agentChatComposerButtonLook({ ...idle, kind: 'send' })).toEqual({
            background: 'primary',
            icon: 'send',
            isDisabled: false,
            isSteerPill: false,
        });
    });

    it('shows Stop on the danger color', () => {
        expect(agentChatComposerButtonLook({ ...idle, isRunning: true, kind: 'stop' })).toEqual({
            background: 'danger',
            icon: 'stop',
            isDisabled: false,
            isSteerPill: false,
        });
    });

    it('wears the steer glyph mid-turn and a pill only beside Queue', () => {
        const steer = { ...idle, isRunning: true, kind: 'send' } as const;
        expect(agentChatComposerButtonLook(steer)).toMatchObject({
            icon: 'steer',
            isSteerPill: false,
        });
        expect(agentChatComposerButtonLook({ ...steer, canQueue: true }).isSteerPill).toBe(true);
    });

    it('drops to the neutral surface when it cannot act, except while busy', () => {
        expect(
            agentChatComposerButtonLook({ ...idle, canSubmit: false, kind: 'stop' }),
        ).toMatchObject({ background: 'neutral', isDisabled: true });
        expect(
            agentChatComposerButtonLook({ ...idle, canSubmit: false, isBusy: true, kind: 'stop' }),
        ).toMatchObject({ background: 'danger', isDisabled: false });
    });
});

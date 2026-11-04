import { describe, expect, it, vi } from 'vitest';

import { ChatDelegationLinks } from '../chat-delegation';
import { turnEndedError, turnNotSteerableError } from '../chat-provider';
import type { ChatState } from '../chat-states';

function fixture(
    send: (message: unknown, options?: unknown) => Promise<void>,
    activeTurnId = 'turn-1',
) {
    const sent = vi.fn(send);
    const followUps = { mustWait: () => true, add: vi.fn() };
    const state = {
        launchId: 'launch',
        sendQueue: Promise.resolve(),
        followUps,
        projection: { snapshot: { activeTurnId } },
        session: { isOpen: true, send: sent },
    } as unknown as ChatState;
    const links = new ChatDelegationLinks({ state: () => state, admit: () => {} });
    return { links, sent, followUps };
}

const steer = { turnId: 'turn-1', inputEpoch: 0, text: 'Updated direction' };
async function refusal(promise: Promise<void>): Promise<string | undefined> {
    try {
        await promise;
    } catch (error) {
        return (error as { details?: { steerRefusal?: string } }).details?.steerRefusal;
    }
    return undefined;
}

describe('ChatDelegationLinks.steerToLaunch', () => {
    it('steers the exact turn, never queues, and does not advance the input epoch', async () => {
        const { links, sent, followUps } = fixture(async () => {});

        await links.steerToLaunch('terminal', 'launch', steer);

        expect(sent).toHaveBeenCalledExactlyOnceWith(
            { text: 'Updated direction' },
            { delivery: 'steered', exactTurnId: 'turn-1' },
        );
        expect(followUps.add).not.toHaveBeenCalled();
        expect(links.inputEpoch('terminal')).toBe(0);
    });

    it('refuses as turn_changed without sending when the active turn is not the claimed one', async () => {
        const { links, sent } = fixture(async () => {}, 'turn-2');

        expect(await refusal(links.steerToLaunch('terminal', 'launch', steer))).toBe(
            'turn_changed',
        );
        expect(sent).not.toHaveBeenCalled();
    });

    it('refuses as human_intervened when a person typed since the claimed epoch', async () => {
        const { links, sent } = fixture(async () => {});
        links.observeHumanInput('terminal');

        expect(await refusal(links.steerToLaunch('terminal', 'launch', steer))).toBe(
            'human_intervened',
        );
        expect(sent).not.toHaveBeenCalled();
    });

    it('refuses as launch_replaced for another launch', async () => {
        const { links, sent } = fixture(async () => {});

        expect(await refusal(links.steerToLaunch('terminal', 'other', steer))).toBe(
            'launch_replaced',
        );
        expect(sent).not.toHaveBeenCalled();
    });

    it('maps a provider that saw the turn end and one that cannot steer to closed refusals', async () => {
        const ended = fixture(() => Promise.reject(turnEndedError()));
        const fixed = fixture(() => Promise.reject(turnNotSteerableError('no')));

        expect(await refusal(ended.links.steerToLaunch('terminal', 'launch', steer))).toBe(
            'turn_changed',
        );
        expect(await refusal(fixed.links.steerToLaunch('terminal', 'launch', steer))).toBe(
            'not_steerable',
        );
    });

    it('rethrows any other failure without a refusal reason, so the delivery stays in doubt', async () => {
        const { links } = fixture(() => Promise.reject(new Error('socket closed')));

        await expect(links.steerToLaunch('terminal', 'launch', steer)).rejects.toThrow(
            'socket closed',
        );
    });
});

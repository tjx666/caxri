import { parseAgentChatAppCommand } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { MobileAgentChatAppCommandState } from '../agent-chat-app-commands';
import { mobileAgentChatBuiltInActions } from '../agent-chat-app-commands';
import { agentChatMenuMatches } from '../agent-chat-commands';

const everything: MobileAgentChatAppCommandState = {
    canConfigure: true,
    canManageSession: true,
    canPlan: true,
    hasUsage: true,
    isPinned: false,
};

const invocations = (state: MobileAgentChatAppCommandState) =>
    mobileAgentChatBuiltInActions(state).map((action) => action.invocation);

describe('mobileAgentChatBuiltInActions', () => {
    it("offers /new-session and the app commands the phone has a control for, in Desktop's order", () => {
        expect(invocations(everything)).toEqual([
            '/new-session',
            '/usage',
            '/model',
            '/plan',
            '/rename',
            '/archive',
            '/pin',
        ]);
    });

    it('drops a command the device cannot run now and keeps /new-session', () => {
        expect(
            invocations({
                canConfigure: false,
                canManageSession: false,
                canPlan: false,
                hasUsage: false,
                isPinned: false,
            }),
        ).toEqual(['/new-session']);
    });

    it('describes /pin as Unpin on a pinned Session', () => {
        const pin = mobileAgentChatBuiltInActions({ ...everything, isPinned: true }).at(-1);
        expect(pin?.invocation).toBe('/pin');
        expect(pin?.description).toBe('Unpin this Session');
    });

    it('leads the menu and wins over a provider command with the same name', () => {
        const builtIn = mobileAgentChatBuiltInActions(everything);
        const rows = agentChatMenuMatches(
            '/',
            [{ name: 'model' }, { name: 'compact' }],
            [],
            builtIn,
        );
        expect(rows?.map((row) => row.invocation)).toEqual([
            ...builtIn.map((action) => action.invocation),
            '/compact',
        ]);
        expect(agentChatMenuMatches('/', [], [], builtIn)).toHaveLength(builtIn.length);
    });

    it('runs only a bare app command the menu offered', () => {
        const builtIn = mobileAgentChatBuiltInActions({ ...everything, canManageSession: false });
        expect(parseAgentChatAppCommand(' /usage ', builtIn)).toBe('usage');
        expect(parseAgentChatAppCommand('/archive', builtIn)).toBeUndefined();
        expect(parseAgentChatAppCommand('/usage now', builtIn)).toBeUndefined();
    });
});

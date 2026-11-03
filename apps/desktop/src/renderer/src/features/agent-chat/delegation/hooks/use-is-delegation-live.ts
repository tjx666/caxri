import { createContext, useContext } from 'react';

/**
 * Whether the Session holding this Chat is the one on screen. A kept-alive Chat in the background stays mounted, so
 * every delegation read and clock inside it (the timeline's record rows, the origin row, the takeover divider) must
 * stop following progress while this is false: the pushes that patch a child Session would otherwise re-render a Chat
 * nobody can see (the hidden-Chat render budget in `e2e/support/agent-chat-switch-budgets.ts`). Defaults to `true`, so
 * a surface that never decides, with no hidden Sessions, stays live.
 */
export const DelegationLiveContext = createContext(true);

export function useIsDelegationLive(): boolean {
    return useContext(DelegationLiveContext);
}

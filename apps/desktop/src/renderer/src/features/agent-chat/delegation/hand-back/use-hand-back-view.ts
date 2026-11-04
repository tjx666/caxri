import { useSyncExternalStore } from 'react';

import { readAgentChatDraft } from '../../composer-input/agent-chat-drafts';
import { subscribeAgentChatDraftChanges } from '../../composer-input/device-state/agent-chat-composer-listeners';
import type { DelegationOrigin, HandBackView } from '../agent-chat-delegation-origin';
import { handBackView } from '../agent-chat-delegation-origin';

/**
 * What the origin row shows for handing the Session back. The composer's draft is read as "is there one", not its text,
 * so typing re-renders the row only when that flips; a typed but unsent message blocks the button because handing back
 * lets the delegating Agent write into this Chat at once.
 */
export function useHandBackView(
    terminalId: string,
    origin: Pick<DelegationOrigin, 'control' | 'isParentArchived'> | undefined,
    isBusy: boolean,
): HandBackView {
    const hasDraft = useSyncExternalStore(
        (listener) => subscribeAgentChatDraftChanges(terminalId, listener),
        () => readAgentChatDraft(terminalId).trim() !== '',
    );
    return origin ? handBackView(origin, { hasDraft, isBusy }) : { kind: 'hidden' };
}

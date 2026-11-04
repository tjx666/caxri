import type { DelegationOrigin } from '../agent-chat-delegation-origin';

export interface HandBackProperties {
    /**
     * Whether this Chat is in a turn or holds queued messages, which blocks handing the Session back.
     */
    isBusy: boolean;
    origin: DelegationOrigin;
    terminalId: string;
    /**
     * The parent Session's display title.
     */
    title: string;
}

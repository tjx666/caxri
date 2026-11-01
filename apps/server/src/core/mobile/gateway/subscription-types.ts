import type {
    MobileEventPayload,
    MobileStreamPayload,
    MobileSubscriptionResource,
} from '@caxri/mobile-transport';
import type { Principal, ServerEvent } from '@caxri/protocol';

import type { TerminalExecutionPort } from '../../../domains/terminal';
import type {
    MobileGatewayFailureReason,
    MobileTerminalResyncReason,
    MobileTerminalTeardownReason,
} from './diagnostics';
import type { MobileTerminalObserver } from './terminal-observer';

/**
 * One socket subscription's state and the options `MobileGatewaySubscriptions` is built with.
 */
export interface Subscription {
    active: boolean;
    activated: boolean;
    /**
     * Whether the subscribe passed authorization. A dashboard pushes from then on, before its acknowledgement; the
     * phone holds those pushes until it has the subscription ID.
     */
    authorized: boolean;
    /**
     * The Session's Project root an Agent Chat subscription names changed files against.
     */
    agentChatProjectRoot?: string;
    /**
     * Set while the root is resolved again after a Session's Workbench Project changed (an Agent's worktree was
     * followed or the user picked another root). Patches published meanwhile ask the phone to re-read instead, because
     * a read resolves the current root and a patch clipped with the old one would name the same file differently.
     */
    agentChatRootRefresh?: symbol;
    /**
     * Releases what the subscription registered as a phone watching an Agent (a Conversation or an Agent Chat).
     */
    closeWatch?: () => void;
    id: string;
    /**
     * The latest change published before the phone saw this subscription's acknowledgement. It is sent as one re-read
     * hint on activation, because the phone may have sent its first read alongside the subscribe and taken a snapshot
     * older than the change.
     */
    missed?: { body: QueuedBody; event: ServerEvent };
    pendingBytes: number;
    pendingFrames: number;
    resource: MobileSubscriptionResource;
    sequence: number;
    tail: Promise<void>;
    terminal?: MobileTerminalObserver;
}

export type PushPayload = MobileEventPayload;

/**
 * What one queued event will send, decided when it is queued so its byte cost is known up front.
 */
export type QueuedBody =
    | {
          kind:
              | 'dashboard.changed'
              | 'conversation.changed'
              | 'changes.changed'
              | 'extensionViews.changed'
              | 'agentChat.changed'
              | 'botInbox.changed';
      }
    | { kind: 'agentChat.patch'; patch: unknown };

export interface MobileSubscriptionOptions {
    authorize: (principal: Principal, resource: MobileSubscriptionResource) => Promise<void>;
    currentPrincipal: () => Principal;
    matches: (
        principal: Principal,
        resource: MobileSubscriptionResource,
        event: ServerEvent,
    ) => Promise<boolean>;
    randomId: () => string;
    send: (payload: MobileEventPayload | MobileStreamPayload) => Promise<void>;
    reportTerminalResync?: (reason: MobileTerminalResyncReason) => void;
    reportTerminalTeardownFailure?: (reason: MobileTerminalTeardownReason) => void;
    reportHumanSteer?: (terminalId: string) => void;
    terminate: (reason?: MobileGatewayFailureReason) => void;
    connectionId: string;
    beginConversation?: (principal: Principal, sessionId: string) => Promise<() => void>;
    beginAgentChat?: (principal: Principal, terminalId: string) => Promise<() => void>;
    agentChatProjectRoot?: (principal: Principal, terminalId: string) => Promise<string>;
    terminalExecution?: TerminalExecutionPort;
}

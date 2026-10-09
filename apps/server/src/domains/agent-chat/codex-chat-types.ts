import type { AgentChatFailureReason } from '@caxri/protocol';

import type { AgentLifecycleSignal } from '../agents';
import type { CodexConnectionEnd } from './codex-connection';

/**
 * Codex thread settings derived from the provider's launch settings. See `launchSettingsToCodexThread`.
 */
export interface CodexThreadSettings {
    approvalPolicy: 'never' | 'on-request' | 'untrusted';
    sandbox: 'danger-full-access' | 'read-only' | 'workspace-write';
    model?: string;
    /**
     * Root `-c key=value` overrides and `--profile`, passed before `app-server` exactly as the TUI would receive them.
     */
    rootArgs: string[];
}

type ChatLifecyclePhase = Extract<
    AgentLifecycleSignal['phase'],
    | 'attentionRequested'
    | 'attentionResolved'
    | 'compactionFinished'
    | 'sessionIdentified'
    | 'turnFailed'
    | 'turnFinished'
    | 'turnStarted'
>;

export interface ChatLifecycleEvent {
    phase: ChatLifecyclePhase;
    agentSessionId?: string;
    agentTurnId?: string;
    agentToolUseId?: string;
    agentFailure?: AgentLifecycleSignal['agentFailure'];
}

/**
 * Closed outcome of one provider process lifetime, for the content-free exit log.
 */
export interface CodexChatExit {
    end: CodexConnectionEnd;
    requested: boolean;
    /**
     * The turn that was running when the process ended, if any; an unrequested end fails it.
     */
    activeTurnId?: string;
    turns: number;
    serverRequests: number;
    rejectedRequests: number;
    droppedFrames: number;
}

/**
 * Start failure carrying a closed reason. `detail` is Caxri-authored copy only.
 */
export class AgentChatStartError extends Error {
    constructor(
        readonly reason: AgentChatFailureReason,
        readonly detail?: string,
    ) {
        super(detail ?? reason);
    }
}

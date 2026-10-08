import type { AgentProvider } from '@caxri/protocol';

import type { AgentEnvironment } from '../contract';

export const agentLifecyclePhases = [
    'sessionIdentified',
    'turnStarted',
    'subagentStarted',
    'attentionRequested',
    'turnFinished',
    'turnFailed',
    'shellToolStarted',
    'shellToolFinished',
    'shellToolFailed',
    'toolBatchFinished',
    'compactionStarted',
    'compactionFinished',
] as const;

export type AgentLifecyclePhase = (typeof agentLifecyclePhases)[number];

/**
 * Why an authenticated lifecycle signal did not become durable state. Every downstream path that declines a signal
 * names one of these instead of returning a bare `false`: an unexplained drop is indistinguishable in the log from a
 * lost hook, which is exactly the failure this vocabulary exists to make diagnosable. The values reach structured logs
 * and are compared against fixed metric labels, so they stay closed and content-free.
 */
export type AgentSignalIgnoredReason =
    /**
     * The provider's hooks are switched off in settings, so the signal is authenticated but unwanted.
     */
    | 'hooksDisabled'
    /**
     * A different provider's CLI ran nested inside this Terminal's launch and inherited its hook environment.
     */
    | 'providerMismatch'
    /**
     * The Terminal exists but its owning Session does not, so no durable state could be attributed.
     */
    | 'sessionMissing'
    /**
     * The signal carries a superseded launch id: the PTY restarted and an older Agent process is still firing.
     */
    | 'staleLaunch'
    /**
     * The event belongs to a replaced provider session or an older turn in the same PTY.
     */
    | 'staleProviderTurn'
    /**
     * A subagent-scoped signal matched a tracked scope but released nothing yet, because sibling subagents are still
     * running or no parent completion was waiting on it. This is the ordinary rhythm of a multi-subagent turn, kept
     * distinct from `subagentUnmatched` so the aggregate does not report healthy sessions as lost hooks.
     */
    | 'subagentPending'
    /**
     * A subagent-scoped signal did not match any tracked subagent scope, so its `subagentStarted` hook was lost or the
     * provider omitted the scope id entirely.
     */
    | 'subagentUnmatched'
    /**
     * The Terminal record is gone, typically because it was closed while its Agent was still running.
     */
    | 'terminalMissing'
    /**
     * The remaining wire fields authenticated, but the phase token is outside this build's closed set. A newer provider
     * event must not look like a forged or malformed packet; the bounded received token is logged separately and never
     * used as a metric label.
     */
    | 'unknownPhase';

/**
 * Result of applying one authenticated lifecycle signal. `'accepted'` means the signal became durable state; every
 * other value is the reason it did not.
 */
export type AgentSignalDecision = 'accepted' | AgentSignalIgnoredReason;

export interface AgentLifecycleSignal {
    /**
     * Absolute working directory the provider reports for the hook event itself, present on every phase. Claude Code's
     * built-in `EnterWorktree` moves its own session directory without touching the PTY, so this is the only public
     * signal that the Agent left the Terminal's launch root. It is the provider's unverified claim: Server Core must
     * prove it against the owning Project's Git worktree topology before any of it becomes durable state.
     */
    agentCwd?: string;
    /**
     * Provider-native session identifier from the hook payload, when the provider supplies one. Only this opaque id
     * crosses the boundary, prompt and response content never do, so a manual in-terminal resume can rebind the
     * Terminal to the session the Agent actually runs.
     */
    agentSessionId?: string;
    /**
     * Provider-native turn identifier. It is content-free and lets a delayed reconciliation query distinguish the exact
     * turn whose completion signal may have been lost.
     */
    agentTurnId?: string;
    /**
     * Coordinator-only evidence: this parent resumed the exact Stop deferred behind tracked subagent work.
     */
    agentContinuedTurnId?: string;
    /**
     * Opt-in delegation evidence. Hashes prove that the bound transcript contains the exact submitted prompt and final
     * response without forwarding either body through the lifecycle channel.
     */
    agentPromptDigest?: string;
    agentResponseDigest?: string;
    /**
     * Grok's final response may share a persisted text chunk with rejected Stop-hook drafts.
     */
    agentResponseByteLength?: number;
    /**
     * Marks a fully parsed delegated Grok Stop, including batches without answer text.
     */
    agentResponseStop?: true;
    agentContentOverflow?: true;
    /**
     * A delegated Grok Stop is evidence only while native background work still continues.
     */
    agentTurnContinues?: true;
    /**
     * Closed StopFailure classification; provider error text never crosses the hook boundary.
     */
    agentFailure?:
        | 'rate_limit'
        | 'billing_error'
        | 'authentication_failed'
        | 'max_output_tokens'
        | 'provider_failed';
    /**
     * Provider-native subagent identifier. The main Agent omits it; matching this scope prevents a nested Agent's
     * completed tool batch from clearing another scope's attention and its completion from settling the parent
     * Session.
     */
    agentId?: string;
    /**
     * Provider-native tool invocation identifier used only to pair one Bash PreToolUse signal with its outcome. It is
     * opaque, bounded, and never joined to Terminal output or transcripts.
     */
    agentToolUseId?: string;
    launchId: string;
    phase: AgentLifecyclePhase;
    provider: AgentProvider;
    terminalId: string;
    /**
     * The bridge saw a bounded Bash command directly invoke `git worktree add`. The command and its output never cross
     * the hook boundary; Server Core must pair its before/after hooks and prove one unique structured Git addition.
     */
    worktreeCreateIntent?: true;
}

export interface AgentHookBinding {
    event: string;
    matcher?: string;
    phase: AgentLifecyclePhase;
    reply?: 'emptyJson';
    interactive?: 'permission' | 'question';
}

export interface AgentHookConfigTarget {
    id: string;
    path: string;
    writable: boolean;
}

export interface DesiredHookInstall {
    bridgePath: string;
    provider: AgentProvider;
    /**
     * Ordering token for the shared provider file: a manager repairs owned entries with a lower version and never
     * touches entries with a higher one. It is not what the socket validates against; that value reaches the bridge
     * through the launch environment.
     */
    schemaVersion: number;
}

export type AgentHookDocuments = ReadonlyMap<string, string | undefined>;

export type AgentHookEntryStatus =
    | { kind: 'absent' }
    | { kind: 'current' }
    | { kind: 'stale'; installedSchema: number }
    | { kind: 'newer'; installedSchema: number }
    | { kind: 'newerIncomplete'; installedSchema: number }
    | { kind: 'drifted' }
    | { kind: 'conflict'; message: string }
    | { kind: 'unparseable'; message: string };

interface AgentHookInspection {
    status: AgentHookEntryStatus;
}

export interface AgentHookConfigEdit {
    source: string;
    targetId: string;
}

interface AgentHookSupport {
    phases: readonly AgentLifecyclePhase[];
    reason?: string;
    supported: boolean;
}

/**
 * Provider-owned, filesystem-free hook configuration behavior. The generic hook manager owns every read, lock, atomic
 * replace, read-back check, watcher, bridge, and socket operation.
 */
export interface AgentHookAdapter {
    readonly bindings: readonly AgentHookBinding[];
    /**
     * Bump whenever `bindings`, the rendered command, or the hook timeout changes. Two builds with equal versions but
     * different rendered entries have no ordering token to settle on, so they would rewrite the shared provider file
     * back and forth forever (issue #557).
     */
    readonly schemaVersion: number;
    configTargets(environment: AgentEnvironment): readonly AgentHookConfigTarget[];
    inspect(documents: AgentHookDocuments, desired: DesiredHookInstall): AgentHookInspection;
    remove(
        documents: AgentHookDocuments,
        desired: DesiredHookInstall,
    ): readonly AgentHookConfigEdit[];
    render(
        documents: AgentHookDocuments,
        desired: DesiredHookInstall,
    ): readonly AgentHookConfigEdit[];
    supports(cliVersion: string | undefined): AgentHookSupport;
}

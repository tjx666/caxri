import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import type {
    AgentActivityState,
    AgentProvider,
    AgentSnapshot,
    ProcessState,
} from '@caxri/protocol';

import type { AgentDelegationAdapter } from './delegation-contract';
import type { AgentHookAdapter, AgentLifecycleSignal } from './hooks/contract';
import type { TimelineBuilder } from './timeline-model';
import type { AgentTranscriptLocation } from './transcript-security';

export interface AgentSnapshotContext {
    /**
     * Keeps repeated probes bound to the Agent session already correlated with this Terminal.
     */
    agentSessionId?: string;
    /**
     * Restricts a lifecycle reconciliation probe to the exact provider turn reported by a hook.
     */
    agentTurnId?: string;
    /**
     * Keeps concurrent unbound Terminals in one Project from sharing a metadata probe.
     */
    correlationId?: string;
    /**
     * Prevents an unbound Terminal from claiming an Agent session already owned or restarted.
     */
    excludedAgentSessionIds?: readonly string[];
    /**
     * PTY shell identity for a bounded provider-owned process probe. Coordinator supplies this only for an unbound,
     * running Agent generation; it is never a filesystem or process-control authority.
     */
    shellPid?: number;
    /**
     * Fails closed when the provider cannot prove identity from the current PTY foreground process. Callers use this
     * only for an already-bound Terminal transition; ordinary unbound discovery may still use provider heuristics.
     */
    requireForegroundProcessIdentity?: boolean;
    processState?: ProcessState;
    rootPath: string;
    /**
     * Rejects same-directory Agent sessions that existed before this Terminal process started.
     */
    startedAt?: number;
}

export interface LocalAgentState {
    /**
     * Provider-owned opaque turn identity used only to distinguish durable activity observations inside Server Core.
     */
    activityTurnId?: string;
    activitySource?: 'exactTurn' | 'latestTurn';
    titleSource?: 'automatic' | 'explicit';
    sessionId?: string;
    /**
     * Provider-owned evidence that the selected conversation is a delegated child rather than a resumable root.
     */
    sessionIsSubagent?: boolean;
    status?: AgentActivityState;
    title?: string;
    usage?: Array<{ label: string; value: string }>;
}

export interface AgentProbeSnapshot extends AgentSnapshot {
    activityTurnId?: string;
    activitySource?: LocalAgentState['activitySource'];
    sessionIsSubagent?: boolean;
}

/**
 * Cache accounting a provider offers for diagnostics. `hits`, `misses`, and `listingReads` are the shape every provider
 * must agree on so one log field means the same thing across providers; the remaining keys are that provider's own
 * closed miss-reason enum, each counting how often it caused a read.
 *
 * Every value is cumulative for the process, not a per-probe delta: probes for different Terminals overlap, so a delta
 * measured around one of them would charge it with another's disk work.
 */
export interface AgentProbeCacheCounters extends Record<string, number> {
    hits: number;
    /**
     * Directory listings rebuilt. A probe can serve every file from cache and still re-`readdir`, which a hit/miss
     * ratio alone would hide.
     */
    listingReads: number;
    misses: number;
}

export interface AgentSessionRenameContext {
    agentSessionId: string;
    cwd: string;
    displayTitle: string;
    signal?: AbortSignal;
}

export interface AgentSessionRenameResult {
    /**
     * The provider-authoritative name. Providers may add a suffix to keep native names unique.
     */
    displayTitle: string;
}

/**
 * Input for a bounded, single-turn text transformation run on a provider's cheapest model. Automatic Session naming is
 * the only caller; the Terminal's long pastes are saved to a file rather than summarized.
 */
export interface AgentLowCostGenerationContext {
    cwd: string;
    prompt: string;
    signal?: AbortSignal;
}

export interface AgentProviderLowCostGenerationContext extends AgentLowCostGenerationContext {
    environment: AgentEnvironment;
    executable: string;
    version: string;
}

export interface AgentProviderSessionRenameContext extends AgentSessionRenameContext {
    environment: AgentEnvironment;
    executable: string;
    version: string;
}

/**
 * Provider-agnostic inputs every `AgentProviderDescriptor` may consult to locate its own on-disk state. This is
 * intentionally generic (home directory, environment variables) so no provider-specific field ever needs to live here;
 * each provider module derives its own directories from these inputs.
 */
export interface AgentEnvironment {
    homeDirectory: string;
    variables: NodeJS.ProcessEnv;
}

export interface AgentActionDiscoveryRoot {
    /**
     * Canonical containment boundary for Project-scoped roots.
     */
    boundaryDirectory?: string;
    directory: string;
    kind: 'commands' | 'skills';
    scope: 'global' | 'project' | 'legacy';
}

export interface AgentActionDiscoveryContext {
    cwd: string;
    projectRoot: string;
}

export interface AgentActionDiscoveryAdapter {
    /**
     * Declares only provider-owned, documented configuration roots. Generic Server code owns bounded traversal and
     * metadata parsing so no provider can accidentally expose file paths or skill bodies over IPC.
     */
    roots(
        context: AgentActionDiscoveryContext,
        environment: AgentEnvironment,
    ): AgentActionDiscoveryRoot[];
    skillInvocation(name: string): string;
    commandInvocation?(relativeName: string): string;
}

export function defaultAgentEnvironment(
    variables: NodeJS.ProcessEnv = process.env,
): AgentEnvironment {
    return { homeDirectory: homedir(), variables };
}

/**
 * One self-contained descriptor per Agent provider. `displayName` and `executableName` live in the shared catalog
 * (`packages/protocol/src/agent/agents.ts`); this interface only carries provider-specific behavior so `service.ts`,
 * `discovery.ts`, and `coordinator.ts` can iterate providers instead of hard-coding a `claude`/`codex` branch each.
 * Provider-local state reads stay pure, and an optional hook adapter describes only that provider's configuration
 * representation; generic Server code owns every filesystem mutation, bridge process, and lifecycle signal.
 */
export interface AgentProviderDescriptor {
    /**
     * Providers without a live-session metadata probe require installed hooks before managed launch.
     */
    requiresLifecycleHooks?: boolean;
    /**
     * Provider-owned arguments applied to every managed Agent Terminal launch, including custom settings and resume.
     */
    managedLaunchArguments?: readonly string[];
    /**
     * Validates provider launch constraints and allocates an exact identity before the PTY starts.
     */
    prepareLaunch?(
        this: void,
        context: {
            args: string[];
            /**
             * Server-owned identity and pointer; only args contains untrusted user arguments.
             */
            assignedAgentSessionId?: string;
            initialPrompt?: string;
            cwd: string;
            environment: AgentEnvironment;
            resumeAgentSessionId?: string;
            version?: string;
        },
    ): Promise<{ args: string[]; agentSessionId: string }>;
    delegation?: AgentDelegationAdapter;
    /**
     * Reads content-free persisted finality for one exact native turn, independently of transcript discovery.
     */
    readTurnStatus?(
        context: Pick<AgentSnapshotContext, 'agentSessionId' | 'agentTurnId'>,
        environment: AgentEnvironment,
    ): Promise<LocalAgentState['status']>;
    /**
     * Classifies an already-accepted `turnFinished` signal's own turn as a provider failure the CLI's hooks could not
     * report, from that provider's persisted transcript content. Only a provider with no native StopFailure-class hook
     * event needs this (issue caxri#1345); Claude and Grok already report their own failure classification through
     * `hooks.ts`. An undefined result leaves the signal exactly as `turnFinished`: this only ever adds a failure the
     * transcript unambiguously proves, never guesses one from an inconclusive read.
     */
    resolvePrimaryTurnFailure?(
        this: void,
        content: string,
        agentTurnId: string,
    ): AgentLifecycleSignal['agentFailure'] | undefined;
    generateTitle?(context: AgentProviderLowCostGenerationContext): Promise<string>;
    actions?: AgentActionDiscoveryAdapter;
    hooks?: AgentHookAdapter;
    id: AgentProvider;
    readState(
        context: AgentSnapshotContext,
        environment: AgentEnvironment,
    ): Promise<LocalAgentState | undefined>;
    /**
     * Process-lifetime accounting for whatever on-disk cache this provider's `readState` sits behind, read by
     * `AgentService` after each probe and written to `agent.probe`. Without it a cache that stopped working is
     * invisible in production: probe duration varies with machine load, so only the hit rate says whether the disk work
     * is still being avoided. Providers that read no cache omit this.
     */
    probeCacheCounters?(this: void): AgentProbeCacheCounters;
    /**
     * Sets the provider-owned conversation name through its supported public CLI boundary. Implementations must fail
     * closed for unsupported versions and must never write provider-private persistence directly.
     */
    renameSession?(context: AgentProviderSessionRenameContext): Promise<AgentSessionRenameResult>;
    /**
     * Structured argv for restoring one provider conversation. This is Server launch behavior, not a browser-safe
     * identity or capability contract.
     */
    resumeArguments(agentSessionId: string): string[];
    /**
     * Derives the absolute path of the provider's on-disk transcript for a bound Agent session. Pure path derivation:
     * no filesystem access; absent when the provider keeps no per-session transcript file.
     */
    transcriptPath?(
        context: { agentSessionId: string; cwd: string },
        environment: AgentEnvironment,
    ): string;
    /**
     * Provider-owned parent of every per-Project transcript root.
     */
    transcriptBaseRoot?(environment: AgentEnvironment): string;
    /**
     * Owning directory for `transcriptPath`. Server canonicalizes this boundary independently before reading or
     * watching the provider file.
     */
    transcriptRoot?(context: { cwd: string }, environment: AgentEnvironment): string;
    /**
     * Locates the transcript when its path cannot be derived purely, e.g. Codex names rollouts by wall-clock time. May
     * list provider-owned directories but must never read transcript contents; Server still canonicalizes the returned
     * boundary before opening the file. `transcriptPath` wins when both are present.
     */
    locateTranscript?(
        context: { agentSessionId: string; cwd: string },
        environment: AgentEnvironment,
        signal?: AbortSignal,
    ): Promise<AgentTranscriptLocation | undefined>;
    /**
     * Appends this provider's projection of one raw transcript line to a mobile timeline page. Pure and synchronous: no
     * filesystem or network access, matching `AgentTimelineService`'s per-line replay. A provider without a durable
     * per-line transcript (Grok streams over ACP with no JSONL analog) omits this, and `AgentTimelineService` reports
     * `unsupported` for that provider instead of guessing at a shape.
     */
    timelineProjector?(this: void, builder: TimelineBuilder, record: unknown, offset: number): void;
}

/**
 * The directory a provider will key its own per-workspace state by, session metadata and transcripts, which is the
 * directory the Agent process is in, not the one its PTY launched in. They diverge when the Agent moves itself, as
 * Claude Code's built-in `EnterWorktree` does. `agentCwd` is set only after Git topology proved it, so falling back to
 * the launch root keeps every Terminal without a proven divergence on exactly its previous behavior.
 *
 * This is deliberately not a filesystem authority: path validation still resolves against the Session's authorized
 * Project root, and `terminals.cwd` remains the Terminal's authorized launch root.
 */
export function agentProviderStateRoot(terminal: { agentCwd?: string; cwd: string }): string {
    return terminal.agentCwd ?? terminal.cwd;
}

/**
 * Ordered directories from the authorized Project root to a Terminal cwd inside it. A cwd outside the Project is
 * deliberately reduced to the Project root so action discovery never broadens filesystem authority.
 */
export function projectDirectories(context: AgentActionDiscoveryContext): string[] {
    const projectRoot = resolve(context.projectRoot);
    const cwd = resolve(context.cwd);
    const suffix = relative(projectRoot, cwd);
    if (
        suffix === '' ||
        (suffix !== '..' && !isAbsolute(suffix) && !suffix.startsWith(`..${sep}`))
    ) {
        const segments = suffix ? suffix.split(sep).filter(Boolean) : [];
        const directories = [
            projectRoot,
            ...segments.map((_, index) => resolve(projectRoot, ...segments.slice(0, index + 1))),
        ];
        /**
         * A persisted path is bounded by the wire schema but can still contain thousands of one-character segments.
         * Keep the Project root plus the deepest 29 ancestors so provider root expansion remains predictably bounded.
         */
        return directories.length <= 30 ? directories : [directories[0], ...directories.slice(-29)];
    }
    return [projectRoot];
}

/**
 * Provider session IDs are opaque basenames, never path fragments. Keeping the rule provider-neutral protects every
 * filesystem-backed capability that correlates a hook signal with local Agent state.
 */
export function isOpaqueAgentSessionId(value: string): boolean {
    return /^[a-z\d][\w.-]{0,255}$/i.test(value) && value !== '.' && value !== '..';
}

export function processStateToAgentActivity(state?: ProcessState): AgentActivityState {
    /**
     * A live interactive CLI may be idle at its prompt, so only settled process outcomes can stand in for Agent
     * activity when provider-owned turn state is unavailable.
     */
    if (state === 'running' || state === 'starting') return 'unknown';
    if (state === 'failed' || state === 'dead') return 'failed';
    if (state === 'stopped') return 'completed';
    return 'unknown';
}

/**
 * Compares Agent-recorded working directories against a Project root without failing on removal.
 */
export async function canonicalPath(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
    }
}

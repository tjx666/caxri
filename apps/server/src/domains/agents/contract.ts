import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import type { AgentActivityState, AgentProvider, ProcessState } from '@caxri/protocol';

import type { AgentHookAdapter } from './hooks/contract';

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
    processState?: ProcessState;
    rootPath: string;
    /**
     * Rejects same-directory Agent sessions that existed before this Terminal process started.
     */
    startedAt?: number;
}

export interface LocalAgentState {
    sessionId?: string;
    status?: AgentActivityState;
    title?: string;
    usage?: Array<{ label: string; value: string }>;
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
    actions?: AgentActionDiscoveryAdapter;
    hooks?: AgentHookAdapter;
    id: AgentProvider;
    readState(
        context: AgentSnapshotContext,
        environment: AgentEnvironment,
    ): Promise<LocalAgentState | undefined>;
    /**
     * Structured argv for restoring one provider conversation. This is Server launch behavior, not a browser-safe
     * identity or capability contract.
     */
    resumeArguments(agentSessionId: string): string[];
    /**
     * Derives the absolute path of the provider's on-disk transcript for a bound Agent session. Pure path derivation —
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

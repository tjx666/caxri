import { realpath } from 'node:fs/promises';

import type { ServerEvent, TerminalRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { AgentEndpointLifecycle } from '../agent-endpoints';
import type { CaxriDatabase } from '../db';
import type { GitWorktreeTopology } from '../git';
import type { WorkbenchRootService } from './roots';

/**
 * Closed causes of an attribution that followed nothing. Logged as `reason`, so a Session whose created worktree was
 * not followed is explainable after the fact and the volume of each cause is measurable.
 */
export type ProvenanceUnavailableReason =
    | 'concurrent_creations'
    | 'creation_overflow'
    | 'duplicate_start'
    | 'multiple_additions'
    | 'no_addition'
    | 'no_baseline'
    | 'no_snapshot'
    | 'path_not_added'
    | 'repository_mismatch'
    | 'scope_changed'
    | 'stale_pending'
    | 'topology_unavailable';

/**
 * Detects a root selection change across asynchronous worktree attribution and following. Validation can re-anchor the
 * device number after a reboot without changing the selected root, so only Project and inode identity cancel an
 * in-flight decision.
 */
export function isSameWorkbenchBinding(
    left: ReturnType<CaxriDatabase['getSessionWorkbenchBinding']>,
    right: ReturnType<CaxriDatabase['getSessionWorkbenchBinding']>,
): boolean {
    return (
        left?.projectId === right?.projectId &&
        left?.workbenchRootProjectId === right?.workbenchRootProjectId &&
        left?.rootInode === right?.rootInode
    );
}

export function launchKey(reference: { launchId: string; terminalId: string }): string {
    return JSON.stringify([reference.terminalId, reference.launchId]);
}

export function creationKey(reference: {
    agentToolUseId?: string;
    launchId: string;
    terminalId: string;
}): string | undefined {
    return reference.agentToolUseId
        ? JSON.stringify([reference.terminalId, reference.launchId, reference.agentToolUseId])
        : undefined;
}

export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
): Promise<T | undefined> {
    let cancelTimeout = () => {};
    try {
        return await Promise.race([
            promise,
            new Promise<undefined>((resolve) => {
                const timer = setTimeout(resolve, timeoutMs);
                cancelTimeout = () => clearTimeout(timer);
            }),
        ]);
    } finally {
        cancelTimeout();
    }
}

/**
 * Picks the one Git addition (relative to a creation's own before-snapshot) a creation produced. A declared path is
 * only a filter over what Git reported: topology reports realpaths, while the command may name a path through a symlink
 * such as `/tmp`, so both the literal and the resolved path are compared. Without one, the addition must be unique.
 */
export async function selectAddition(
    topology: GitWorktreeTopology,
    beforeRootPaths: ReadonlySet<string>,
    declaredPath: string | undefined,
): Promise<
    { reason: 'multiple_additions' | 'no_addition' | 'path_not_added' } | { rootPath: string }
> {
    const additions = topology.worktrees.filter(({ rootPath }) => !beforeRootPaths.has(rootPath));
    if (additions.length === 0) return { reason: 'no_addition' };
    let matches = additions;
    if (declaredPath !== undefined) {
        const candidates = new Set([declaredPath]);
        try {
            candidates.add(await realpath(declaredPath));
        } catch {
            // The directory is gone or unreadable; only the literal path can match.
        }
        matches = additions.filter(({ rootPath }) => candidates.has(rootPath));
    }
    if (matches.length > 1) return { reason: 'multiple_additions' };
    return matches.length === 1 ? { rootPath: matches[0].rootPath } : { reason: 'path_not_added' };
}

export async function retireAgentWorkbenchProvenance(options: {
    endpoints: AgentEndpointLifecycle | undefined;
    logger: StructuredLogger;
    terminalId: string;
    workbenchRoots: WorkbenchRootService;
}): Promise<void> {
    options.workbenchRoots.retireTerminal(options.terminalId);
    try {
        await options.endpoints?.retire(options.terminalId);
    } catch (error: unknown) {
        options.logger.write('warn', logEventCatalog.agentEndpoint.retireFailed, {
            fields: {
                terminalId: options.terminalId,
                error: error instanceof Error ? error.message : String(error),
            },
        });
    }
}

/**
 * Records the hook launch's owning Git topology before the Agent can spawn, independently of Agent Endpoint support.
 */
export async function primeAgentWorkbenchProvenance(options: {
    launchId: string;
    projectId: string;
    terminal: TerminalRecord;
    workbenchRoots: WorkbenchRootService;
}): Promise<void> {
    const { launchId, projectId, terminal, workbenchRoots } = options;
    if (terminal.kind === 'shell')
        throw new CaxriError('CONFLICT', 'Shell Terminals cannot establish Agent provenance');
    await workbenchRoots.primeAgentLaunch({
        launchId,
        projectId,
        provider: terminal.kind,
        sessionId: terminal.sessionId,
        terminalId: terminal.id,
    });
}

/**
 * Persist only verified observations, and refresh reference consumers even when worktree following is disabled or done.
 */
export function updateObservedAgentCwd(
    options: { database: CaxriDatabase; emit(event: ServerEvent): void },
    terminal: Pick<TerminalRecord, 'id' | 'provider'>,
    agentCwd: string | undefined,
): void {
    if (
        !terminal.provider ||
        !options.database.setTerminalAgentCwd(terminal.id, terminal.provider, agentCwd)
    )
        return;
    options.emit({
        event: 'state.changed',
        payload: { kind: 'records', terminalIds: [terminal.id], sessionIds: [] },
    });
}

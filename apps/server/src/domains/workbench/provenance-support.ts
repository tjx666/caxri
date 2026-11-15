import { realpath } from 'node:fs/promises';

import type { ServerEvent, TerminalRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { errorLogFields, logEventCatalog } from '@caxri/system';

import type { AgentEndpointLifecycle } from '../agent-endpoints';
import type { CaxriDatabase } from '../db';
import type { GitWorktreeTopology } from '../git';
import { worktreeCreatedAt } from './root-discovery';
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

/**
 * How long before Server Core saw a creation start its worktree may already exist and still count as that creation's.
 *
 * A Codex or ACP Chat reports a command only as a notification sent while the command already runs, so under Full
 * access `git worktree add` can finish before the before-snapshot is taken. In the observed case the worktree's `.git`
 * file was born about 80 ms before Server Core processed the start; the window leaves room for a busy event loop
 * without reaching back to a worktree from an earlier command.
 */
export const LATE_SNAPSHOT_GRACE_MS = 5_000;

async function declaredPathCandidates(declaredPath: string): Promise<Set<string>> {
    const candidates = new Set([declaredPath]);
    try {
        candidates.add(await realpath(declaredPath));
    } catch {
        // The directory is gone or unreadable; only the literal path can match.
    }
    return candidates;
}

/**
 * Recovers a creation whose before-snapshot raced the command and already held the new worktree. Only the exact path
 * the successful command named qualifies, only when Git reports it as a linked worktree, and only when its `.git` file
 * was born no earlier than {@link LATE_SNAPSHOT_GRACE_MS} before the creation started. An older worktree at that path,
 * or one whose birth time the filesystem cannot report, still follows nothing.
 */
async function selectLateSnapshotAddition(
    topology: GitWorktreeTopology,
    beforeRootPaths: ReadonlySet<string>,
    candidates: ReadonlySet<string>,
    startedAt: number,
): Promise<string | undefined> {
    const matches = topology.worktrees.filter(
        ({ isMain, rootPath }) =>
            isMain !== true && beforeRootPaths.has(rootPath) && candidates.has(rootPath),
    );
    if (matches.length !== 1) return undefined;
    const bornAt = await worktreeCreatedAt(matches[0].rootPath);
    return bornAt !== undefined && bornAt >= startedAt - LATE_SNAPSHOT_GRACE_MS
        ? matches[0].rootPath
        : undefined;
}

/**
 * Picks the one Git addition (relative to a creation's own before-snapshot) a creation produced. A declared path is
 * only a filter over what Git reported: topology reports realpaths, while the command may name a path through a symlink
 * such as `/tmp`, so both the literal and the resolved path are compared. Without one, the addition must be unique.
 * When the declared path is no addition, a before-snapshot that raced the command may still prove it; see
 * {@link selectLateSnapshotAddition}; that recovery logs `workbench_root.provenance_late_snapshot` so its volume stays
 * measurable.
 */
export async function selectAddition(
    topology: GitWorktreeTopology,
    creation: {
        baseline: { provider: string; terminalId: string };
        pending: { createdAt: number; declaredPath?: string };
        rootPaths: ReadonlySet<string>;
    },
    logger: StructuredLogger,
): Promise<
    { reason: 'multiple_additions' | 'no_addition' | 'path_not_added' } | { rootPath: string }
> {
    const { baseline, pending, rootPaths: beforeRootPaths } = creation;
    const { declaredPath } = pending;
    const additions = topology.worktrees.filter(({ rootPath }) => !beforeRootPaths.has(rootPath));
    if (declaredPath === undefined) {
        if (additions.length === 0) return { reason: 'no_addition' };
        return additions.length === 1
            ? { rootPath: additions[0].rootPath }
            : { reason: 'multiple_additions' };
    }
    const candidates = await declaredPathCandidates(declaredPath);
    const matches = additions.filter(({ rootPath }) => candidates.has(rootPath));
    if (matches.length > 1) return { reason: 'multiple_additions' };
    if (matches.length === 1) return { rootPath: matches[0].rootPath };
    const late = await selectLateSnapshotAddition(
        topology,
        beforeRootPaths,
        candidates,
        pending.createdAt,
    );
    if (late) {
        logger.write('info', logEventCatalog.workbenchRoot.provenanceLateSnapshot, {
            fields: { provider: baseline.provider, terminalId: baseline.terminalId },
        });
        return { rootPath: late };
    }
    return additions.length === 0 ? { reason: 'no_addition' } : { reason: 'path_not_added' };
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
                ...errorLogFields(error),
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

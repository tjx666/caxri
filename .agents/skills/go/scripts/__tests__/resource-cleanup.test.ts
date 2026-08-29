import { describe, expect, it } from 'vitest';

import type { ResourceAuditDependencies } from '../resource-cleanup';
import { auditGoResources, findRelatedWorktreeProcesses } from '../resource-cleanup';
import { invalidateResourceCleanupBeforeAudit } from '../resource-cleanup-run';
import { createInitialState } from '../state-model';

const WORKTREE_PATH = '/repo/caxri-worktrees/chore-resource-cleanup';
const RUN_DIRECTORY = `${WORKTREE_PATH}/.records/go/run-1`;

function finalizationState() {
    const state = createInitialState({
        objective: 'Clean resources',
        runId: 'run-1',
        worktree: {
            baseSha: 'base-1',
            createdAt: '2026-08-29T00:00:00.000Z',
            mainCheckoutPath: '/repo/caxri',
            path: WORKTREE_PATH,
        },
    });
    state.phase = 'finalization';
    state.status = 'active';
    state.finalization = {
        deliveredAt: '2026-08-29T02:00:00.000Z',
        headSha: 'head-1',
        issues: [{ number: 1, projectStatus: 'Done', state: 'CLOSED' }],
        mergeSha: 'merge-1',
        path: 'finalization.json',
        pullRequestNumber: 1,
        verifiedAt: '2026-08-29T01:59:00.000Z',
    };
    return state;
}

function dependencies(
    overrides: Partial<ResourceAuditDependencies> = {},
): ResourceAuditDependencies {
    return {
        hasAcceptanceRuntime: () => Promise.resolve(false),
        inspectRunTemporaryFiles: () => Promise.resolve([]),
        inspectWorktreeProcesses: () => Promise.resolve([]),
        inspectWorktreeStatus: () => Promise.resolve({ desktopLease: 'free', devProcess: 'none' }),
        ...overrides,
    };
}

describe('Go final resource cleanup', () => {
    it('finds an orphaned Bun in the current worktree without exposing its arguments', () => {
        expect(
            findRelatedWorktreeProcesses(
                [
                    {
                        command: 'bun run .records/cdp-tool.ts eval secret-prompt',
                        cwd: WORKTREE_PATH,
                        name: 'bun',
                        pid: 123,
                        ppid: 1,
                    },
                    {
                        command: 'bun run dev',
                        cwd: '/repo/another-worktree',
                        name: 'bun',
                        pid: 456,
                        ppid: 1,
                    },
                    {
                        command: `${WORKTREE_PATH}/apps/server/dist/server/bundles/server-core.js`,
                        cwd: '/',
                        name: 'bun',
                        pid: 124,
                        ppid: 1,
                    },
                    {
                        command: 'bun run resource-audit',
                        cwd: WORKTREE_PATH,
                        name: 'bun',
                        pid: 900,
                        ppid: 800,
                    },
                    {
                        command: 'codex',
                        cwd: WORKTREE_PATH,
                        name: 'codex',
                        pid: 800,
                        ppid: 700,
                    },
                ],
                WORKTREE_PATH,
                900,
            ),
        ).toEqual([
            { name: 'bun', pid: 123 },
            { name: 'bun', pid: 124 },
        ]);
    });

    it('fails closed until every current-worktree runtime resource is gone', async () => {
        const state = finalizationState();

        await expect(
            auditGoResources(
                state,
                RUN_DIRECTORY,
                [],
                dependencies({
                    hasAcceptanceRuntime: () => Promise.resolve(true),
                    inspectRunTemporaryFiles: () => Promise.resolve(['temporary_file']),
                    inspectWorktreeProcesses: () => Promise.resolve([{ name: 'bun', pid: 123 }]),
                    inspectWorktreeStatus: () =>
                        Promise.resolve({
                            desktopLease: 'stale',
                            devProcess: 'active',
                        }),
                }),
            ),
        ).rejects.toThrow(
            'acceptance_runtime, desktop_lease, development_instance, temporary_file, worktree_process(pid=123,name=bun)',
        );
        expect(state.resourceCleanup).toBeNull();
    });

    it('records a compact receipt after a clean audit and preserves recovery categories', async () => {
        const state = finalizationState();
        const receipt = await auditGoResources(
            state,
            RUN_DIRECTORY,
            ['worktree_process', 'acceptance_runtime'],
            dependencies(),
            '2026-08-29T03:00:00.000Z',
        );

        expect(receipt).toEqual({
            auditedAt: '2026-08-29T03:00:00.000Z',
            recovered: ['acceptance_runtime', 'worktree_process'],
            runId: 'run-1',
            status: 'recovered',
            worktreePath: WORKTREE_PATH,
        });
        expect(state.resourceCleanup).toEqual(receipt);
    });

    it('invalidates an old cleanup receipt before a repeated audit can fail', () => {
        const state = finalizationState();
        state.resourceCleanup = {
            auditedAt: '2026-08-29T03:00:00.000Z',
            recovered: [],
            runId: state.runId,
            status: 'clean',
            worktreePath: WORKTREE_PATH,
        };

        invalidateResourceCleanupBeforeAudit(state);

        expect(state.resourceCleanup).toBeNull();
        expect(state.events.at(-1)).toMatchObject({
            detail: 'Invalidated by resource-audit',
            type: 'resource_cleanup',
        });
    });

    it('refuses to audit while Go-owned validation or mutation work is still active', async () => {
        const state = finalizationState();
        state.mutationLease = {
            acquiredAt: '2026-08-29T02:30:00.000Z',
            holderId: 'repair-1',
            kind: 'repair',
        };

        await expect(auditGoResources(state, RUN_DIRECTORY, [], dependencies())).rejects.toThrow(
            'mutation lease',
        );
    });
});

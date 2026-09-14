import type { WorkbenchRootOption } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { selectWorkbenchRoot } from './workbench-root-commands';
import {
    visibleWorkbenchRoots,
    workbenchRootLabel,
    workbenchRootSearchScore,
} from './workbench-root-options';

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    confirm:
        vi.fn<
            (options: { message: string; title: string; confirmLabel: string }) => Promise<boolean>
        >(),
    refresh: vi.fn(),
}));
vi.mock('../../lib/caxri', () => ({
    caxri: { request: mocks.request, window: { showConfirm: mocks.confirm } },
}));
vi.mock('../../stores/workbench', () => ({
    useWorkbenchStore: { getState: () => ({ refresh: mocks.refresh }) },
}));
vi.mock('../../stores/toasts', () => ({
    tryCommand: async (_message: string, operation: () => Promise<unknown>) => {
        try {
            return await operation();
        } catch {
            return;
        }
    },
}));

function option(id: string, extra: Partial<WorkbenchRootOption> = {}): WorkbenchRootOption {
    return {
        worktreeId: id,
        rootPath: `/worktrees/${id}`,
        branch: `feature/${id}`,
        displayTitle: id,
        authorization: 'required',
        owner: false,
        isMain: false,
        ...extra,
    };
}

describe('Workbench Root picker', () => {
    it('matches branch/path substrings without fuzzy hits across shared directory names', () => {
        expect(
            workbenchRootSearchScore('id', 'feature/manual', [
                'feature/recent-1',
                '/tmp/manual-worktrees/recent-1',
            ]),
        ).toBe(0);
        expect(workbenchRootSearchScore('id', 'FEATURE/MANUAL', ['feature/manual'])).toBe(1);
        expect(workbenchRootSearchScore('id', 'recent-1', ['/tmp/worktrees/recent-1'])).toBe(1);
    });
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.request.mockResolvedValue({ id: 'session' });
        mocks.refresh.mockResolvedValue(undefined);
    });
    it('pins current and main while retaining the five newest entries regardless of authorization', () => {
        const current = option('current', { projectId: 'current', authorization: 'authorized' });
        const main = option('main', { isMain: true });
        const linked = Array.from({ length: 7 }, (_, index) =>
            option(String(index), { createdAt: index + 1 }),
        );
        const roots = [main, ...linked, current];
        expect(
            visibleWorkbenchRoots(roots, 'current', false).map((root) => root.worktreeId),
        ).toEqual(['current', '6', '5', '4', '3', '2', 'main']);
        expect(visibleWorkbenchRoots(roots, 'current', true)).toHaveLength(9);
        expect(visibleWorkbenchRoots([main], undefined, false)).toEqual([main]);
    });
    it('sorts unknown timestamps deterministically and disambiguates only ambiguous branch labels', () => {
        const alpha = option('alpha');
        const beta = option('beta');
        expect(visibleWorkbenchRoots([beta, alpha], undefined, true)).toEqual([alpha, beta]);
        expect(workbenchRootLabel(alpha, [alpha, beta])).toBe('feature/alpha');
        expect(workbenchRootLabel(option('detached-folder', { branch: 'detached' }), [])).toBe(
            'Detached · detached-folder',
        );
        expect(workbenchRootLabel(alpha, [alpha, option('other', { branch: alpha.branch })])).toBe(
            'feature/alpha · alpha',
        );
    });
    it('cancels first authorization without submitting or refreshing state', async () => {
        mocks.confirm.mockResolvedValue(false);
        await expect(selectWorkbenchRoot('session', option('unapproved'))).resolves.toBe(
            'canceled',
        );
        expect(mocks.request).not.toHaveBeenCalled();
        expect(mocks.refresh).not.toHaveBeenCalled();
    });
    it('shows the destination and sends only its ID after explicit confirmation', async () => {
        mocks.confirm.mockResolvedValue(true);
        await expect(selectWorkbenchRoot('session', option('unapproved'))).resolves.toBe(
            'selected',
        );
        expect(mocks.confirm.mock.calls[0]?.[0].message).toContain('/worktrees/unapproved');
        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('session.authorizeWorkbenchRoot', {
            sessionId: 'session',
            worktreeId: 'unapproved',
        });
        expect(mocks.refresh).toHaveBeenCalledOnce();
    });
    it('switches an authorized Project without asking for another grant', async () => {
        await selectWorkbenchRoot(
            'session',
            option('approved', { projectId: 'project', authorization: 'authorized' }),
        );
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('session.selectWorkbenchRoot', {
            sessionId: 'session',
            projectId: 'project',
        });
    });
    it('keeps failed authorization distinct from a completed switch', async () => {
        mocks.confirm.mockResolvedValue(true);
        mocks.request.mockRejectedValue(new Error('Worktree replaced'));
        await expect(selectWorkbenchRoot('session', option('stale'))).resolves.toBe('failed');
        expect(mocks.refresh).not.toHaveBeenCalled();
    });
});

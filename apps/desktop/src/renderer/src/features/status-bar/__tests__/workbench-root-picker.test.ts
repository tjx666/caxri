import type { WorkbenchRootOption } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { translate } from '../../../i18n';
import { selectWorkbenchRoot } from '../workbench-root-commands';
import { visibleWorkbenchRoots, workbenchRootLabel } from '../workbench-root-options';

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    confirm:
        vi.fn<
            (options: {
                message: string;
                title: string;
                confirmLabel: string;
                dontAskAgainLabel?: string;
            }) => Promise<{ isConfirmed: boolean; dontAskAgain: boolean }>
        >(),
    refresh: vi.fn(),
    settings: {} as Record<string, unknown>,
    getSettings: vi.fn(() => Promise.resolve({ source: '{}' })),
    updateSettings: vi.fn<(update: { source: string }) => Promise<void>>(() => Promise.resolve()),
}));
vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.request, window: { showConfirmChoice: mocks.confirm } },
}));
vi.mock('../../../stores/selectors', () => ({
    getBootstrap: () => ({ settings: mocks.settings }),
}));
vi.mock('../../settings/settings-client', () => ({
    getSettings: mocks.getSettings,
    updateSettings: mocks.updateSettings,
}));
vi.mock('../../../stores/workbench', () => ({
    useWorkbenchStore: { getState: () => ({ refresh: mocks.refresh }) },
}));
vi.mock('../../../stores/toasts', () => ({
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
        title: id,
        authorization: 'required',
        owner: false,
        isMain: false,
        ...extra,
    };
}

describe('Workbench Root picker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.settings = {};
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
        expect(workbenchRootLabel(alpha, [alpha, beta], translate)).toBe('feature/alpha');
        expect(
            workbenchRootLabel(option('detached-folder', { branch: 'detached' }), [], translate),
        ).toBe('Detached · detached-folder');
        expect(
            workbenchRootLabel(
                alpha,
                [alpha, option('other', { branch: alpha.branch })],
                translate,
            ),
        ).toBe('feature/alpha · alpha');
    });
    it('cancels first authorization without submitting or refreshing state', async () => {
        mocks.confirm.mockResolvedValue({ isConfirmed: false, dontAskAgain: false });
        await expect(selectWorkbenchRoot('session', option('unapproved'))).resolves.toBe(
            'canceled',
        );
        expect(mocks.request).not.toHaveBeenCalled();
        expect(mocks.refresh).not.toHaveBeenCalled();
    });
    it('shows the destination and sends only its ID after explicit confirmation', async () => {
        mocks.confirm.mockResolvedValue({ isConfirmed: true, dontAskAgain: false });
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
    it('turns the question off when the user confirms with "Don\'t ask again" ticked', async () => {
        mocks.confirm.mockResolvedValue({ isConfirmed: true, dontAskAgain: true });
        await expect(selectWorkbenchRoot('session', option('unapproved'))).resolves.toBe(
            'selected',
        );
        expect(mocks.confirm.mock.calls[0]?.[0].dontAskAgainLabel).toBe("Don't ask again");
        expect(JSON.parse(mocks.updateSettings.mock.calls[0]?.[0].source ?? '{}')).toEqual({
            'workbench.confirmWorktreeAuthorization': false,
        });
        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('session.authorizeWorkbenchRoot', {
            sessionId: 'session',
            worktreeId: 'unapproved',
        });
    });
    it('authorizes without asking once the setting is off', async () => {
        mocks.settings = { 'workbench.confirmWorktreeAuthorization': false };
        await expect(selectWorkbenchRoot('session', option('unapproved'))).resolves.toBe(
            'selected',
        );
        expect(mocks.confirm).not.toHaveBeenCalled();
        expect(mocks.updateSettings).not.toHaveBeenCalled();
        expect(mocks.request).toHaveBeenCalledExactlyOnceWith('session.authorizeWorkbenchRoot', {
            sessionId: 'session',
            worktreeId: 'unapproved',
        });
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
        mocks.confirm.mockResolvedValue({ isConfirmed: true, dontAskAgain: false });
        mocks.request.mockRejectedValue(new Error('Worktree replaced'));
        await expect(selectWorkbenchRoot('session', option('stale'))).resolves.toBe('failed');
        expect(mocks.refresh).not.toHaveBeenCalled();
    });
});

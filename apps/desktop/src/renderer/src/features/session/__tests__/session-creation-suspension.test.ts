import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve(null)),
    pushToast: vi.fn(),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../../stores/toasts', () => ({
    pushToast: mocks.pushToast,
    tryCommand: vi.fn(),
}));

const { useDialogStore } = await import('../../../stores/dialogs');
const { configurePendingAgent, isPendingRootGrantStale, resumePendingSession } =
    await import('../session-creation-commands');

describe('configuring an Agent during Session creation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        useDialogStore.getState().clearPending();
    });

    it('hides the dialog and opens Settings without revoking the folder grant', () => {
        useDialogStore.getState().askAgentForRoot('/work/app');
        const settingsId = useDialogStore.getState().settingsRequest.id;

        configurePendingAgent('claude');

        const state = useDialogStore.getState();
        expect(state.isPendingSuspended).toBe(true);
        expect(state.pendingRoot).toBe('/work/app');
        expect(state.settingsRequest).toMatchObject({
            id: settingsId + 1,
            view: 'agent-executable',
            provider: 'claude',
        });
        expect(mocks.caxriRequest).not.toHaveBeenCalled();
    });

    it('resumes the same pending folder while the grant is fresh', () => {
        useDialogStore.getState().askAgentForRoot('/work/app');
        configurePendingAgent('codex');

        resumePendingSession();

        expect(useDialogStore.getState()).toMatchObject({
            isPendingSuspended: false,
            pendingRoot: '/work/app',
        });
    });

    it('resumes an existing Project without any expiry', () => {
        useDialogStore.getState().askAgentForProject('project-1');
        configurePendingAgent('codex');
        vi.setSystemTime(Date.now() + 10 * 60_000);

        resumePendingSession();
        vi.useRealTimers();

        expect(useDialogStore.getState().pendingProjectId).toBe('project-1');
        expect(useDialogStore.getState().isPendingSuspended).toBe(false);
    });

    it('drops a lapsed folder grant, explains it, and reopens the folder picker', () => {
        vi.useFakeTimers();
        useDialogStore.getState().askAgentForRoot('/work/app');
        configurePendingAgent('claude');
        vi.setSystemTime(Date.now() + 61_000);

        resumePendingSession();
        vi.useRealTimers();

        expect(mocks.caxriRequest).toHaveBeenCalledWith('project.cancelCreate', {
            rootPath: '/work/app',
        });
        expect(useDialogStore.getState().pendingRoot).toBeUndefined();
        expect(mocks.pushToast).toHaveBeenCalledWith('warning', expect.any(String), {
            history: false,
        });
    });

    it('treats only an aged folder grant as stale', () => {
        expect(isPendingRootGrantStale(undefined, 1_000_000)).toBe(false);
        expect(isPendingRootGrantStale(1_000_000, 1_020_000)).toBe(false);
        expect(isPendingRootGrantStale(1_000_000, 1_060_000)).toBe(true);
    });
});

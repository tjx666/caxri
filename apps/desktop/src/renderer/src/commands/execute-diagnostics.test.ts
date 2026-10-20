import type { MouseEvent } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/caxri', () => ({ caxri: { request: mocks.request } }));
/**
 * `execute.ts` imports `git-review-navigation-commands.ts`, which reaches `git-review-comment-binding.ts` for its
 * mounted-editor registry; that module imports Monaco, which needs a real `window` unavailable under this suite's
 * `node` environment (see `vitest.config.ts`). Nothing in this suite exercises Git review navigation, so the binding
 * registry is stubbed out instead of loaded.
 */
vi.mock('../features/editor/git-review-comment-binding', () => ({
    listBoundGitReviewCommentEditors: () => new Set(),
}));

import { useEnvironmentStore } from '../stores/environment';
import { configureToastActions } from '../stores/toast-actions';
import { dismissToast, getToasts } from '../stores/toasts';
import { executeCommand } from './execute';
import { toastActionHandlers } from './toast-actions';

// The window installs these once at startup; a toast's button carries only the name of its follow-up, so without the
// table the click below would report the follow-up as gone instead of running it.
configureToastActions(toastActionHandlers);

describe('diagnostics export recovery', () => {
    beforeEach(() => {
        mocks.request.mockReset();
        dismissToast();
        // Exporting diagnostics is a local-only command, so the suite runs as a local window.
        useEnvironmentStore.setState({ state: { kind: 'local' } });
    });

    afterEach(() => {
        dismissToast();
        vi.unstubAllGlobals();
    });

    it('keeps the export label in the toast and copies the captured error on request', async () => {
        const failure = new Error("EACCES: open '/read-only/report.zip'");
        const writeText = vi.fn(() => Promise.resolve());
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        mocks.request.mockRejectedValueOnce(failure);

        executeCommand('diagnostics.export');
        await vi.waitFor(() => expect(getToasts()).toHaveLength(1));
        const notification = getToasts()[0];
        expect(notification.title).toBe('Diagnostics export failed. Permission was denied.');
        if (
            !notification.action ||
            typeof notification.action !== 'object' ||
            !('onClick' in notification.action)
        ) {
            throw new Error('Expected diagnostics recovery action');
        }
        expect(typeof notification.action.onClick).toBe('function');
        const preventDefault = vi.fn();
        notification.action.onClick({ preventDefault } as unknown as MouseEvent<HTMLButtonElement>);
        // Held on screen so the button can show its in-place `Copied` acknowledgement.
        expect(preventDefault).toHaveBeenCalled();
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(failure.message));
    });
});

import type { MouseEvent } from 'react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { dismissToast, getToasts } from '../stores/toasts';
import { executeCommand } from './execute';

describe('diagnostics export recovery', () => {
    beforeEach(() => {
        mocks.request.mockReset();
        dismissToast();
    });

    afterEach(() => {
        dismissToast();
        vi.unstubAllGlobals();
    });

    it('keeps the export label in the toast and copies the captured error on request', async () => {
        const failure = new Error("EACCES: open '/Users/jing/private/report.zip'");
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
        notification.action.onClick({} as MouseEvent<HTMLButtonElement>);
        await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(failure.message));
    });
});

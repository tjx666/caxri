import type { MessageBoxOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, BrowserWindow: {}, dialog: {}, shell: {} }));

const { shouldInstallDataResettingUpdate } = await import('../desktop-update-service');

const EXPORT = 0;
const UPDATE = 1;
const CANCEL = 2;

function prompt(responses: number[], exportProjects = vi.fn()) {
    const showMessageBox = vi.fn<(options: MessageBoxOptions) => Promise<{ response: number }>>(
        () => Promise.resolve({ response: responses.shift() ?? CANCEL }),
    );
    return {
        exportProjects,
        result: shouldInstallDataResettingUpdate({
            exportProjects,
            showMessageBox,
            version: '2.0.0',
        }),
        showMessageBox,
    };
}

describe('shouldInstallDataResettingUpdate', () => {
    it('installs only on Update Anyway', async () => {
        await expect(prompt([UPDATE]).result).resolves.toBe(true);
        await expect(prompt([CANCEL]).result).resolves.toBe(false);
    });

    it('exports first, then asks again with the saved path and Update as the default', async () => {
        const exportProjects = vi.fn(() =>
            Promise.resolve({
                path: '/Users/me/caxri-projects.json',
                projectCount: 1,
                sessionCount: 2,
            }),
        );
        const { result, showMessageBox } = prompt([EXPORT, UPDATE], exportProjects);

        await expect(result).resolves.toBe(true);
        expect(exportProjects).toHaveBeenCalledOnce();
        expect(showMessageBox).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                message: 'Caxri 2.0.0 will clear your Projects and Sessions',
                defaultId: EXPORT,
                cancelId: CANCEL,
            }),
        );
        const second = showMessageBox.mock.calls[1][0];
        expect(second.detail).toContain('Exported to /Users/me/caxri-projects.json.');
        expect(second.defaultId).toBe(UPDATE);
    });

    it('keeps the decision open when the export is cancelled or fails', async () => {
        const exportProjects = vi
            .fn()
            .mockResolvedValueOnce(null)
            .mockRejectedValueOnce(new Error('Server Core is not running'));
        const { result, showMessageBox } = prompt([EXPORT, EXPORT, CANCEL], exportProjects);

        await expect(result).resolves.toBe(false);
        expect(showMessageBox).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                detail: 'The export failed: Server Core is not running',
                defaultId: EXPORT,
            }),
        );
    });
});

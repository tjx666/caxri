import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
    openPath: vi.fn<(path: string) => Promise<string>>(),
    showItemInFolder: vi.fn<(path: string) => void>(),
}));
vi.mock('electron', () => ({
    shell: { openPath: electron.openPath, showItemInFolder: electron.showItemInFolder },
}));

import type { MainRequest } from '@caxri/protocol';

import { handleLogRequest, isLogRequest } from '../main-log-methods';

const reveal = { method: 'logs.reveal', params: {} } as MainRequest;
const revealExport = { method: 'diagnostics.revealExport', params: {} } as MainRequest;

describe('main log methods', () => {
    beforeEach(() => {
        electron.openPath.mockReset().mockResolvedValue('');
        electron.showItemInFolder.mockReset();
    });

    it('claims only the two log requests', () => {
        expect(isLogRequest(reveal)).toBe(true);
        expect(isLogRequest(revealExport)).toBe(true);
        expect(isLogRequest({ method: 'updates.check', params: {} })).toBe(false);
    });

    it('opens the logs folder of the profile without asking the Server', async () => {
        if (!isLogRequest(reveal)) throw new Error('unreachable');
        await handleLogRequest(reveal, '/profile', {});
        expect(electron.openPath).toHaveBeenCalledWith('/profile/logs');
    });

    it('reports a folder the OS refused to open', async () => {
        if (!isLogRequest(reveal)) throw new Error('unreachable');
        electron.openPath.mockResolvedValueOnce('no such folder');
        await expect(handleLogRequest(reveal, '/profile', {})).rejects.toThrow('no such folder');
    });

    it('reveals only the bundle Main itself saw exported', async () => {
        if (!isLogRequest(revealExport)) throw new Error('unreachable');
        await expect(handleLogRequest(revealExport, '/profile', {})).rejects.toThrow(
            'No diagnostics bundle',
        );
        await handleLogRequest(revealExport, '/profile', {
            lastDiagnosticsExportPath: '/tmp/report.zip',
        });
        expect(electron.showItemInFolder).toHaveBeenCalledWith('/tmp/report.zip');
    });
});

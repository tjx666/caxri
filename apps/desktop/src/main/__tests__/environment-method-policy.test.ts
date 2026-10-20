import { describe, expect, it, vi } from 'vitest';

import { guardEnvironmentMethods, isMethodAvailable } from '../environment-method-policy';

describe('environment method policy', () => {
    it('keeps local-only methods out of SSH Host windows', () => {
        expect(isMethodAvailable('theme.import', 'ssh')).toBe(false);
        expect(isMethodAvailable('dialog.selectDirectory', 'ssh')).toBe(false);
        expect(isMethodAvailable('theme.import', 'local')).toBe(true);
    });

    it('keeps SSH-only methods out of the local Workbench', () => {
        expect(isMethodAvailable('sshHost.stopServer', 'local')).toBe(false);
        expect(isMethodAvailable('sshHost.stopServer', 'ssh')).toBe(true);
    });

    it('lets both environments call shared and remote-override methods', () => {
        for (const environment of ['local', 'ssh'] as const) {
            expect(isMethodAvailable('environment.get', environment)).toBe(true);
            expect(isMethodAvailable('project.create', environment)).toBe(true);
            expect(isMethodAvailable('files.trash', environment)).toBe(true);
        }
    });

    it('rejects a refused request before the handler runs', async () => {
        const handler = vi.fn(() => Promise.resolve(null));
        const guarded = guardEnvironmentMethods('ssh', handler);

        await expect(
            guarded({ method: 'theme.import', params: {} } as never),
        ).rejects.toMatchObject({ code: 'UNAVAILABLE' });
        expect(handler).not.toHaveBeenCalled();

        await expect(guarded({ method: 'environment.get', params: {} })).resolves.toBeNull();
        expect(handler).toHaveBeenCalledOnce();
    });
});

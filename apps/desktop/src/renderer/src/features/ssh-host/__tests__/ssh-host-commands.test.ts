import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn(), showConfirm: vi.fn() }));
vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.request, window: { showConfirm: mocks.showConfirm } },
}));

import { useEnvironmentStore } from '../../../stores/environment';
import { dismissToast } from '../../../stores/toasts';
import { didReplySshHostPrompt, stopSshHostServer } from '../ssh-host-commands';
import { pickSshHostFolder, settleSshHostFolder } from '../ssh-host-dialogs-store';

beforeEach(() => {
    mocks.request.mockReset();
    mocks.showConfirm.mockReset();
    dismissToast();
    useEnvironmentStore.setState({
        state: { kind: 'ssh', destination: 'devbox', phase: 'connected', needsUserAction: false },
    });
});

describe('stopSshHostServer', () => {
    it('stops the Server only after the user confirms', async () => {
        mocks.showConfirm.mockResolvedValueOnce(false);
        await stopSshHostServer();
        expect(mocks.request).not.toHaveBeenCalled();

        mocks.showConfirm.mockResolvedValueOnce(true);
        mocks.request.mockResolvedValueOnce(undefined);
        await stopSshHostServer();
        expect(JSON.stringify(mocks.showConfirm.mock.lastCall)).toContain('devbox');
        expect(mocks.request).toHaveBeenCalledWith('remote.stopServer');
    });

    it('does nothing in a local window', async () => {
        useEnvironmentStore.setState({ state: { kind: 'local' } });
        await stopSshHostServer();
        expect(mocks.showConfirm).not.toHaveBeenCalled();
    });
});

describe('didReplySshHostPrompt', () => {
    it('reports whether the answer reached Main', async () => {
        mocks.request.mockResolvedValueOnce(undefined);
        await expect(didReplySshHostPrompt('request-1', 'yes')).resolves.toBe(true);
        expect(mocks.request).toHaveBeenCalledWith('remote.askpass.reply', {
            requestId: 'request-1',
            response: 'yes',
        });
        mocks.request.mockRejectedValueOnce(new Error('gone'));
        await expect(didReplySshHostPrompt('request-1', null)).resolves.toBe(false);
    });
});

describe('pickSshHostFolder', () => {
    it('resolves with the chosen folder, and a newer request cancels the one still open', async () => {
        const first = pickSshHostFolder();
        const second = pickSshHostFolder();
        await expect(first).resolves.toBeUndefined();
        settleSshHostFolder('/home/dev/app');
        await expect(second).resolves.toBe('/home/dev/app');
    });
});

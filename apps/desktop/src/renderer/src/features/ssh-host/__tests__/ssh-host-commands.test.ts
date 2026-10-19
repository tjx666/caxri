import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn(), showConfirm: vi.fn() }));
vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.request, window: { showConfirm: mocks.showConfirm } },
}));

import { useEnvironmentStore } from '../../../stores/environment';
import { dismissToast } from '../../../stores/toasts';
import {
    cancelSshHostConnection,
    connectToSshHost,
    didReplySshHostPrompt,
    retrySshHostNow,
    revealSshConfig,
    stopSshHostServer,
} from '../ssh-host-commands';
import {
    pickSshHostFolder,
    setConnectSshHostOpen,
    settleSshHostFolder,
    useSshHostDialogsStore,
} from '../ssh-host-dialogs-store';

beforeEach(() => {
    mocks.request.mockReset();
    mocks.showConfirm.mockReset();
    dismissToast();
    useEnvironmentStore.setState({
        state: {
            kind: 'ssh',
            destination: 'devbox',
            hostIdentity: 'devbox',
            phase: 'connected',
            needsUserAction: false,
        },
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

describe('connection actions', () => {
    it('cancels the running attempt and reveals the SSH config through Main', async () => {
        mocks.request.mockResolvedValue(null);
        await cancelSshHostConnection();
        expect(mocks.request).toHaveBeenCalledWith('remote.cancel');
        await retrySshHostNow();
        expect(mocks.request).toHaveBeenCalledWith('remote.retryNow');
        await revealSshConfig();
        expect(mocks.request).toHaveBeenCalledWith('remote.sshConfig.reveal');
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

describe('connectToSshHost', () => {
    it('keeps the picker open with the destination pending until Main opens the window', async () => {
        const opened = Promise.withResolvers<undefined>();
        mocks.request.mockReturnValueOnce(opened.promise);
        setConnectSshHostOpen(true);

        const connecting = connectToSshHost('work');
        expect(useSshHostDialogsStore.getState()).toMatchObject({
            isConnectOpen: true,
            connectingDestination: 'work',
        });
        await connectToSshHost('other');
        expect(mocks.request).toHaveBeenCalledTimes(1);

        opened.resolve(undefined);
        await connecting;
        expect(mocks.request).toHaveBeenCalledWith('remote.connect', { destination: 'work' });
        expect(useSshHostDialogsStore.getState()).toMatchObject({ isConnectOpen: false });
        expect(useSshHostDialogsStore.getState().connectingDestination).toBeUndefined();
    });

    it('leaves a picker reopened during the wait alone', async () => {
        const opened = Promise.withResolvers<undefined>();
        mocks.request.mockReturnValueOnce(opened.promise);
        setConnectSshHostOpen(true);
        const connecting = connectToSshHost('work');

        setConnectSshHostOpen(false);
        setConnectSshHostOpen(true);
        opened.resolve(undefined);
        await connecting;

        expect(useSshHostDialogsStore.getState()).toMatchObject({ isConnectOpen: true });
    });

    it('closes the picker after a failure it reported', async () => {
        mocks.request.mockRejectedValueOnce(new Error('no window'));
        setConnectSshHostOpen(true);
        await connectToSshHost('work');
        expect(useSshHostDialogsStore.getState()).toMatchObject({ isConnectOpen: false });
    });
});

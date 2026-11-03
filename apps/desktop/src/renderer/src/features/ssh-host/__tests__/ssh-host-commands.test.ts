import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn<(...arguments_: unknown[]) => Promise<unknown>>(),
    showConfirm: vi.fn(),
}));
/**
 * Records each request with the machine it was sent to: `local` for this Mac, else the SSH Host's id.
 */
vi.mock('../../../lib/caxri', () => ({
    caxri: {
        in: (environmentId: string | undefined) => ({
            request: (...arguments_: unknown[]) =>
                mocks.request(environmentId ?? 'local', ...arguments_),
        }),
        request: (...arguments_: unknown[]) => mocks.request('local', ...arguments_),
        window: { showConfirm: mocks.showConfirm },
    },
}));

import { useEnvironmentStore } from '../../../stores/environment';
import { dismissToast } from '../../../stores/toasts';
import {
    cancelSshHostConnection,
    connectToSshHost,
    didReplySshHostPrompt,
    disconnectSshHost,
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
        hosts: [
            {
                kind: 'ssh',
                destination: 'devbox',
                hostIdentity: 'dev@devbox:22',
                phase: 'connected',
                needsUserAction: false,
            },
        ],
    });
});

describe('stopSshHostServer', () => {
    it('stops the Server only after the user confirms', async () => {
        mocks.showConfirm.mockResolvedValueOnce(false);
        await stopSshHostServer('dev@devbox:22');
        expect(mocks.request).not.toHaveBeenCalled();

        mocks.showConfirm.mockResolvedValueOnce(true);
        mocks.request.mockResolvedValueOnce(undefined);
        await stopSshHostServer('dev@devbox:22');
        expect(JSON.stringify(mocks.showConfirm.mock.lastCall)).toContain('devbox');
        expect(mocks.request).toHaveBeenCalledWith('dev@devbox:22', 'sshHost.stopServer');
    });

    it('does nothing for an SSH Host that is no longer connected', async () => {
        await stopSshHostServer('dev@gone:22');
        expect(mocks.showConfirm).not.toHaveBeenCalled();
    });
});

describe('connection actions', () => {
    it('cancels the running attempt and reveals the SSH config through Main', async () => {
        mocks.request.mockResolvedValue(null);
        await cancelSshHostConnection('dev@devbox:22');
        expect(mocks.request).toHaveBeenCalledWith('dev@devbox:22', 'sshHost.cancel');
        await retrySshHostNow('dev@devbox:22');
        expect(mocks.request).toHaveBeenCalledWith('dev@devbox:22', 'sshHost.retryNow');
        await disconnectSshHost('dev@devbox:22');
        expect(mocks.request).toHaveBeenCalledWith('dev@devbox:22', 'sshHost.disconnect');
        await revealSshConfig();
        expect(mocks.request).toHaveBeenCalledWith('local', 'sshHost.sshConfig.reveal');
    });
});

describe('didReplySshHostPrompt', () => {
    it('reports whether the answer reached Main', async () => {
        mocks.request.mockResolvedValueOnce(undefined);
        await expect(didReplySshHostPrompt('dev@devbox:22', 'request-1', 'yes')).resolves.toBe(
            true,
        );
        expect(mocks.request).toHaveBeenCalledWith('dev@devbox:22', 'sshHost.askpass.reply', {
            requestId: 'request-1',
            response: 'yes',
        });
        mocks.request.mockRejectedValueOnce(new Error('gone'));
        await expect(didReplySshHostPrompt('dev@devbox:22', 'request-1', null)).resolves.toBe(
            false,
        );
    });
});

describe('pickSshHostFolder', () => {
    it('resolves with the chosen folder, and a newer request cancels the one still open', async () => {
        const first = pickSshHostFolder('dev@devbox:22');
        const second = pickSshHostFolder('dev@gpu:22');
        await expect(first).resolves.toBeUndefined();
        expect(useSshHostDialogsStore.getState().folderEnvironmentId).toBe('dev@gpu:22');
        settleSshHostFolder('/home/dev/app');
        await expect(second).resolves.toBe('/home/dev/app');
        expect(useSshHostDialogsStore.getState().folderEnvironmentId).toBeUndefined();
    });
});

describe('connectToSshHost', () => {
    it('keeps the picker open with the destination pending until Main connects the Host', async () => {
        const opened = Promise.withResolvers<{ environmentId: string }>();
        mocks.request.mockReturnValueOnce(opened.promise);
        setConnectSshHostOpen(true);

        const connecting = connectToSshHost('work');
        expect(useSshHostDialogsStore.getState()).toMatchObject({
            isConnectOpen: true,
            connectingDestination: 'work',
        });
        await connectToSshHost('other');
        expect(mocks.request).toHaveBeenCalledTimes(1);

        opened.resolve({ environmentId: 'dev@work:22' });
        await expect(connecting).resolves.toBe('dev@work:22');
        expect(mocks.request).toHaveBeenCalledWith('local', 'sshHost.connect', {
            destination: 'work',
        });
        expect(useSshHostDialogsStore.getState()).toMatchObject({ isConnectOpen: false });
        expect(useSshHostDialogsStore.getState().connectingDestination).toBeUndefined();
    });

    it('asks for the first folder once a Host with no Project yet is connected', async () => {
        const host = {
            kind: 'ssh' as const,
            destination: 'work',
            hostIdentity: 'dev@work:22',
            phase: 'connecting' as const,
            needsUserAction: false,
        };
        useEnvironmentStore.setState({ hosts: [host] });
        mocks.request.mockImplementation((_environment, method) => {
            if (method === 'sshHost.connect')
                return Promise.resolve({ environmentId: 'dev@work:22' });
            if (method === 'app.bootstrap')
                return Promise.resolve({
                    projects: [],
                    sessions: [],
                    terminals: [],
                    archivedTerminals: [],
                });
            return Promise.resolve(null);
        });

        await connectToSshHost('work');
        expect(useSshHostDialogsStore.getState().folderEnvironmentId).toBeUndefined();
        useEnvironmentStore.setState({ hosts: [{ ...host, phase: 'connected' }] });
        await vi.waitFor(() =>
            expect(useSshHostDialogsStore.getState().folderEnvironmentId).toBe('dev@work:22'),
        );
        settleSshHostFolder(undefined);
    });

    it('leaves a picker reopened during the wait alone', async () => {
        const opened = Promise.withResolvers<{ environmentId: string }>();
        mocks.request.mockReturnValueOnce(opened.promise);
        setConnectSshHostOpen(true);
        const connecting = connectToSshHost('work');

        setConnectSshHostOpen(false);
        setConnectSshHostOpen(true);
        opened.resolve({ environmentId: 'dev@work:22' });
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

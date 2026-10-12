import { EventEmitter } from 'node:events';

import type { ServerEvent, SshEnvironmentState } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type {
    RemoteEnvironmentHooks,
    RemoteEnvironmentsOptions,
    RemoteHostSupervisor,
} from '../remote-environments';
import { createRemoteEnvironments } from '../remote-environments';
import type { DesktopServerConnection } from '../server-connection';

// eslint-disable-next-line unicorn/prefer-event-target -- stands in for Electron's BrowserWindow, an EventEmitter
class FakeWindow extends EventEmitter {
    readonly webContents = { id: Math.random() };
    destroyed = false;
    focus = vi.fn();
    show = vi.fn();
    isDestroyed = () => this.destroyed;
    isMinimized = () => false;
    restore = vi.fn();
    destroy = () => {
        this.destroyed = true;
        this.emit('closed');
    };
}

interface Harness {
    connection: { start: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn> };
    events: ServerEvent[];
    hooks: RemoteEnvironmentHooks;
    supervisor: {
        dispose: ReturnType<typeof vi.fn>;
        isFailed: ReturnType<typeof vi.fn>;
        reconnect: ReturnType<typeof vi.fn>;
    };
    window: FakeWindow;
}

function setup(start: (harness: Harness) => Promise<void> = () => Promise.resolve()) {
    const harnesses: Harness[] = [];
    const logger = { write: vi.fn() };
    const options: RemoteEnvironmentsOptions = {
        create: (_destination, hooks) => {
            const window = new FakeWindow();
            const events: ServerEvent[] = [];
            const connection = {
                start: vi.fn(() => start(harnesses.at(-1)!)),
                resume: vi.fn(() => Promise.resolve()),
                close: vi.fn(),
                onEvent: vi.fn(() => () => {}),
                stopServer: vi.fn(() => Promise.resolve()),
                request: vi.fn(() => Promise.resolve(null)),
            };
            const supervisor = {
                dispose: vi.fn(() => Promise.resolve()),
                isFailed: vi.fn(() => false),
                reconnect: vi.fn(),
            };
            harnesses.push({ connection, events, hooks, supervisor, window });
            return {
                connection: connection as unknown as DesktopServerConnection,
                route: {
                    isRecovering: () => false,
                    onEventsReady: () => {},
                    transport: {} as never,
                },
                sendEvent: (event) => events.push(event),
                supervisor: supervisor as unknown as RemoteHostSupervisor,
                window: window as never,
            };
        },
        keyOf: (destination) => destination.replace(/:22$/u, ''),
        listHosts: () => Promise.resolve([{ alias: 'build-box' }]),
        logger: () => logger,
        recent: {
            list: () => Promise.resolve(['dev@build-box']),
            remember: () => Promise.resolve(),
        },
    };
    return { environments: createRemoteEnvironments(options), harnesses, logger };
}

function lastState(harness: Harness): SshEnvironmentState {
    const event = harness.events.findLast((candidate) => candidate.event === 'environment.changed');
    return event?.payload as SshEnvironmentState;
}

describe('SSH Host environments', () => {
    it('opens one window per SSH Host and focuses it on a second connect', async () => {
        const { environments, harnesses } = setup();
        await environments.connect('dev@build-box');
        await environments.connect('dev@build-box:22');

        expect(harnesses).toHaveLength(1);
        expect(harnesses[0].window.focus).toHaveBeenCalled();
        await vi.waitFor(() => expect(lastState(harnesses[0]).phase).toBe('connected'));
    });

    it('routes a window to its own environment and answers local for any other sender', async () => {
        const { environments, harnesses } = setup();
        await environments.connect('dev@build-box');
        const { webContents } = harnesses[0].window;

        expect(environments.methodsFor(webContents as never).get()).toMatchObject({
            kind: 'ssh',
            destination: 'dev@build-box',
        });
        expect(environments.methodsFor({} as never).get()).toEqual({ kind: 'local' });
        expect(environments.route(webContents as never)).toBeDefined();
    });

    it('shows an askpass prompt in the state and settles it with the reply', async () => {
        const { environments, harnesses, logger } = setup();
        await environments.connect('dev@build-box');
        const harness = harnesses[0];
        const answer = harness.hooks.askpass(
            { requestId: 'r1', kind: 'secret', prompt: "dev@build-box's password:" },
            new AbortController().signal,
        );

        expect(lastState(harness).askpass).toMatchObject({ requestId: 'r1', kind: 'secret' });
        environments.methodsFor(harness.window.webContents as never).replyAskpass('r1', 'hunter2');

        await expect(answer).resolves.toBe('hunter2');
        expect(lastState(harness).askpass).toBeUndefined();
        const logged = JSON.stringify(logger.write.mock.calls);
        expect(logged).not.toContain('hunter2');
    });

    it('cancels a prompt the askpass helper gave up on', async () => {
        const { environments, harnesses } = setup();
        await environments.connect('dev@build-box');
        const controller = new AbortController();
        const answer = harnesses[0].hooks.askpass(
            {
                requestId: 'r1',
                kind: 'confirm',
                prompt: 'Are you sure you want to continue connecting?',
            },
            controller.signal,
        );
        controller.abort();

        await expect(answer).resolves.toBeNull();
    });

    it('stops at a failure the user must resolve and retries on Reconnect', async () => {
        let attempts = 0;
        const { environments, harnesses } = setup((started) => {
            attempts += 1;
            started.hooks.update({
                failure: { reason: 'authentication', message: 'Permission denied' },
            });
            return Promise.reject(new CaxriError('UNAVAILABLE', 'Permission denied (publickey)'));
        });
        await environments.connect('dev@build-box');
        const harness = harnesses[0];

        await vi.waitFor(() => expect(lastState(harness).phase).toBe('failed'));
        expect(lastState(harness)).toMatchObject({
            needsUserAction: true,
            failure: { reason: 'authentication' },
        });

        await environments.methodsFor(harness.window.webContents as never).reconnect();
        expect(harness.supervisor.reconnect).toHaveBeenCalledOnce();
        expect(harness.connection.resume).toHaveBeenCalledOnce();
        expect(lastState(harness).phase).toBe('connected');
        expect(attempts).toBe(1);
    });

    it('does not ask for an answer when a failure has nothing to answer', async () => {
        const { environments, harnesses } = setup((started) => {
            // A terminal failure: automatic reconnection stops, yet there is no prompt to answer.
            started.supervisor.isFailed.mockReturnValue(true);
            started.hooks.update({
                failure: { reason: 'profileInUse', message: 'In use by login-1' },
            });
            return Promise.reject(new CaxriError('UNAVAILABLE', 'In use by login-1'));
        });
        await environments.connect('dev@build-box');
        const harness = harnesses[0];

        await vi.waitFor(() => expect(lastState(harness).phase).toBe('failed'));
        expect(lastState(harness)).toMatchObject({
            needsUserAction: false,
            failure: { reason: 'profileInUse', message: 'In use by login-1' },
        });
    });

    it('detaches without stopping the remote Server when the window closes', async () => {
        const { environments, harnesses } = setup();
        await environments.connect('dev@build-box');
        const harness = harnesses[0];
        const pending = harness.hooks.askpass(
            { requestId: 'r1', kind: 'secret', prompt: 'Password:' },
            new AbortController().signal,
        );
        harness.window.destroy();

        await expect(pending).resolves.toBeNull();
        await vi.waitFor(() => expect(harness.supervisor.dispose).toHaveBeenCalledOnce());
        expect(environments.list()).toHaveLength(0);
    });

    it('logs each phase transition with its duration and closed reason', async () => {
        const { environments, harnesses, logger } = setup(() => new Promise(() => {}));
        await environments.connect('dev@build-box');
        harnesses[0].hooks.update({ phase: 'probing' });

        const phaseChange = logger.write.mock.calls.find(
            (call) => call[1] === 'remote_ssh.phase_changed',
        );
        expect(phaseChange).toMatchObject([
            'info',
            'remote_ssh.phase_changed',
            { fields: { phase: 'probing', previousPhase: 'connecting' } },
        ]);
    });
});

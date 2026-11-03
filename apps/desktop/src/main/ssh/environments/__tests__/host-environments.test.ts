import type { ServerEvent, SshEnvironmentState } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { DesktopServerConnection } from '../../../connection/server-connection';
import type {
    SshHostEnvironmentHooks,
    SshHostEnvironmentsOptions,
    SshHostSupervisor,
} from '../host-environments';
import { createSshHostEnvironments } from '../host-environments';
import type { HostPreferencesStore } from '../host-preferences';

interface Harness {
    connection: {
        start: ReturnType<typeof vi.fn>;
        resume: ReturnType<typeof vi.fn>;
        retryNow: ReturnType<typeof vi.fn>;
    };
    events: ServerEvent[];
    hooks: SshHostEnvironmentHooks;
    supervisor: {
        cancel: ReturnType<typeof vi.fn>;
        dispose: ReturnType<typeof vi.fn>;
        isFailed: ReturnType<typeof vi.fn>;
        reconnect: ReturnType<typeof vi.fn>;
    };
    focusWorkbench: ReturnType<typeof vi.fn>;
    unbind: ReturnType<typeof vi.fn>;
}

function setup(
    start: (harness: Harness) => Promise<void> = () => Promise.resolve(),
    keyOf: SshHostEnvironmentsOptions['keyOf'] = (destination) => destination.replace(/:22$/u, ''),
) {
    const harnesses: Harness[] = [];
    const logger = { write: vi.fn() };
    const onEnvironmentsChanged = vi.fn<SshHostEnvironmentsOptions['onEnvironmentsChanged']>();
    const recordConnected = vi.fn<HostPreferencesStore['recordConnected']>(() => Promise.resolve());
    const options: SshHostEnvironmentsOptions = {
        create: (_destination, _environmentId, hooks) => {
            const focusWorkbench = vi.fn();
            const unbind = vi.fn();
            const events: ServerEvent[] = [];
            const connection = {
                start: vi.fn(() => start(harnesses.at(-1)!)),
                resume: vi.fn(() => Promise.resolve()),
                retryNow: vi.fn(() => true),
                close: vi.fn(),
                onEvent: vi.fn(() => () => {}),
                stopServer: vi.fn(() => Promise.resolve()),
                request: vi.fn(() => Promise.resolve(null)),
            };
            const supervisor = {
                cancel: vi.fn(),
                dispose: vi.fn(() => Promise.resolve()),
                isFailed: vi.fn(() => false),
                reconnect: vi.fn(),
            };
            harnesses.push({ connection, events, focusWorkbench, hooks, supervisor, unbind });
            return {
                connection: connection as unknown as DesktopServerConnection,
                focusWorkbench,
                route: {
                    isRecovering: () => false,
                    onEventsReady: () => {},
                    windowKey: 'main',
                    transport: {} as never,
                    window: () => {},
                },
                sendEvent: (event) => events.push(event),
                supervisor: supervisor as unknown as SshHostSupervisor,
                unbind,
            };
        },
        keyOf,
        listHosts: () => Promise.resolve([{ alias: 'build-box' }]),
        logger: () => logger,
        onEnvironmentsChanged,
        recent: {
            list: () => Promise.resolve(['dev@build-box']),
            remember: () => Promise.resolve(),
        },
        revealSshConfig: () => Promise.resolve(),
        preferences: { recordConnected } as unknown as HostPreferencesStore,
    };
    return {
        environments: createSshHostEnvironments(options),
        harnesses,
        logger,
        onEnvironmentsChanged,
        recordConnected,
    };
}

function lastState(harness: Harness): SshEnvironmentState {
    const event = harness.events.findLast((candidate) => candidate.event === 'environment.changed');
    return event?.payload as SshEnvironmentState;
}

describe('SSH Host environments', () => {
    it('keeps one connection per SSH Host and answers its id on a second connect', async () => {
        const { environments, harnesses, onEnvironmentsChanged } = setup();
        const first = await environments.connect('dev@build-box');
        const second = await environments.connect('dev@build-box:22');

        expect(harnesses).toHaveLength(1);
        expect(second).toBe(first);
        await vi.waitFor(() => expect(lastState(harnesses[0]).phase).toBe('connected'));
        expect(onEnvironmentsChanged.mock.lastCall?.[0]).toEqual([
            expect.objectContaining({ hostIdentity: 'dev@build-box', phase: 'connected' }),
        ]);
    });

    it('remembers how a connected SSH Host was reached for Settings › Hosts', async () => {
        const { environments, harnesses, recordConnected } = setup();
        await environments.connect('dev@build-box');
        await vi.waitFor(() => expect(lastState(harnesses[0]).phase).toBe('connected'));
        expect(recordConnected).toHaveBeenCalledWith('dev@build-box', 'dev@build-box', undefined);
    });

    it('connects several SSH Hosts side by side and lists each', async () => {
        const { environments, harnesses } = setup();
        const build = await environments.connect('dev@build-box');
        const lab = await environments.connect('dev@lab-box');

        expect(harnesses).toHaveLength(2);
        expect(build).not.toBe(lab);
        expect(environments.methodsFor(undefined).list()).toHaveLength(2);
        expect(environments.methodsFor(lab).get()).toMatchObject({ destination: 'dev@lab-box' });
    });

    it('reuses the connection of an alias that resolves to the same SSH Host and says why', async () => {
        // Both aliases name the same account, as `ssh -G` would resolve them.
        const { environments: aliased, harnesses } = setup(undefined, () =>
            Promise.resolve('dev@203.0.113.7:22'),
        );
        await aliased.connect('work');
        await aliased.connect('work');
        expect(
            harnesses[0].events.filter((event) => event.event === 'environment.connectionReused'),
        ).toEqual([]);

        await aliased.connect('work-direct');

        expect(harnesses).toHaveLength(1);
        expect(
            harnesses[0].events.filter((event) => event.event === 'environment.connectionReused'),
        ).toEqual([
            { event: 'environment.connectionReused', payload: { destination: 'work-direct' } },
        ]);
    });

    it('names the environment by the resolved SSH Host key, not only the alias that connected it', async () => {
        const { environments, harnesses } = setup(undefined, () =>
            Promise.resolve('dev@203.0.113.7:22'),
        );
        const id = await environments.connect('work');

        expect(id).toBe('dev@203.0.113.7:22');
        expect(environments.methodsFor(id).get()).toMatchObject({
            destination: 'work',
            hostIdentity: 'dev@203.0.113.7:22',
        });
        await vi.waitFor(() => expect(lastState(harnesses[0]).phase).toBe('connected'));
        expect(lastState(harnesses[0]).hostIdentity).toBe('dev@203.0.113.7:22');
    });

    it('reuses the connection of the same spelling without resolving the destination again', async () => {
        const keyOf = vi.fn((destination: string) => Promise.resolve(destination));
        const { environments, harnesses } = setup(undefined, keyOf);
        await environments.connect('work');
        keyOf.mockImplementation(() => new Promise<string>(() => {}));

        await environments.connect('work');

        expect(keyOf).toHaveBeenCalledTimes(1);
        expect(harnesses).toHaveLength(1);
    });

    it('routes a named environment to its SSH Host and refuses an unknown one', async () => {
        const { environments } = setup();
        const id = await environments.connect('dev@build-box');

        expect(environments.methodsFor(id).get()).toMatchObject({
            kind: 'ssh',
            destination: 'dev@build-box',
        });
        expect(environments.methodsFor(undefined).get()).toEqual({ kind: 'local' });
        expect(environments.route(id)).toBeDefined();
        expect(environments.route('dev@elsewhere')).toBeUndefined();
        expect(() => environments.methodsFor('dev@elsewhere').retryNow()).toThrow(
            'The SSH Host is not connected',
        );
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
        expect(harness.focusWorkbench).toHaveBeenCalledOnce();
        environments.methodsFor('dev@build-box').replyAskpass('r1', 'hunter2');

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

        await environments.methodsFor('dev@build-box').reconnect();
        expect(harness.supervisor.reconnect).toHaveBeenCalledOnce();
        expect(harness.connection.resume).toHaveBeenCalledOnce();
        expect(lastState(harness).phase).toBe('connected');
        expect(attempts).toBe(1);
    });

    it('reports a lease another Desktop took over and takes it back only on Use Here', async () => {
        const { environments, harnesses } = setup();
        await environments.connect('dev@build-box');
        const harness = harnesses[0];
        await vi.waitFor(() => expect(lastState(harness).phase).toBe('connected'));
        const onEvent = (harness.connection as unknown as { onEvent: ReturnType<typeof vi.fn> })
            .onEvent;
        const emit = onEvent.mock.calls[0]?.[0] as (event: ServerEvent) => void;

        emit({ event: 'host.connectionChanged', payload: { status: 'replaced' } });
        expect(lastState(harness)).toMatchObject({
            phase: 'disconnected',
            needsUserAction: false,
            failure: { reason: 'takenOver' },
        });
        expect(harness.connection.resume).not.toHaveBeenCalled();

        await environments.methodsFor('dev@build-box').reconnect();
        expect(harness.connection.resume).toHaveBeenCalledOnce();
        expect(lastState(harness)).toMatchObject({ phase: 'connected', needsUserAction: false });
        expect(lastState(harness).failure).toBeUndefined();
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

    it('names the known_hosts entry of a host-key failure', async () => {
        const { environments, harnesses } = setup(
            (started) => {
                started.supervisor.isFailed.mockReturnValue(true);
                started.hooks.update({
                    failure: { reason: 'hostKey', message: 'Host key verification failed.' },
                });
                return Promise.reject(
                    new CaxriError('UNAVAILABLE', 'Host key verification failed.'),
                );
            },
            () => Promise.resolve('dev@build-box:2222'),
        );
        await environments.connect('build-box');
        const harness = harnesses[0];

        await vi.waitFor(() => expect(lastState(harness).phase).toBe('failed'));
        expect(lastState(harness)).toMatchObject({
            needsUserAction: true,
            failure: { reason: 'hostKey', knownHostsName: '[build-box]:2222' },
        });
    });

    it('cancels a running attempt, answering its open prompt, and does not ask for an answer after', async () => {
        const { environments, harnesses } = setup(() => new Promise(() => {}));
        await environments.connect('dev@build-box');
        const harness = harnesses[0];
        const methods = environments.methodsFor('dev@build-box');
        const pending = harness.hooks.askpass(
            { requestId: 'r1', kind: 'secret', prompt: 'Password:' },
            new AbortController().signal,
        );

        methods.cancel();

        await expect(pending).resolves.toBeNull();
        expect(harness.supervisor.cancel).toHaveBeenCalledOnce();
        harness.hooks.update({
            phase: 'failed',
            failure: { reason: 'cancelled', message: 'Connection cancelled' },
        });
        expect(lastState(harness)).toMatchObject({
            phase: 'failed',
            needsUserAction: false,
            failure: { reason: 'cancelled' },
        });
        // Nothing is running any more, so a second Cancel does nothing.
        methods.cancel();
        expect(harness.supervisor.cancel).toHaveBeenCalledOnce();
        expect(() => environments.methodsFor(undefined).cancel()).toThrow();
    });

    it('skips the reconnect backoff only while the SSH Host is reconnecting', async () => {
        const { environments, harnesses } = setup();
        await environments.connect('dev@build-box');
        const harness = harnesses[0];
        const methods = environments.methodsFor('dev@build-box');
        await vi.waitFor(() => expect(lastState(harness).phase).toBe('connected'));

        expect(methods.retryNow()).toBe(false);
        expect(harness.connection.retryNow).not.toHaveBeenCalled();

        harness.hooks.update({ phase: 'reconnecting', attempt: 1 });
        expect(methods.retryNow()).toBe(true);
        expect(harness.connection.retryNow).toHaveBeenCalledOnce();
        expect(() => environments.methodsFor(undefined).retryNow()).toThrow();
    });

    it('detaches without stopping the remote Server on Disconnect', async () => {
        const { environments, harnesses, onEnvironmentsChanged } = setup();
        const id = await environments.connect('dev@build-box');
        const harness = harnesses[0];
        const pending = harness.hooks.askpass(
            { requestId: 'r1', kind: 'secret', prompt: 'Password:' },
            new AbortController().signal,
        );
        await environments.methodsFor(id).disconnect();

        await expect(pending).resolves.toBeNull();
        expect(harness.supervisor.dispose).toHaveBeenCalledOnce();
        expect(harness.unbind).toHaveBeenCalledOnce();
        expect(environments.list()).toHaveLength(0);
        expect(onEnvironmentsChanged.mock.lastCall?.[0]).toEqual([]);
        expect(environments.route(id)).toBeUndefined();
    });

    it('logs each phase transition with its duration and closed reason', async () => {
        const { environments, harnesses, logger } = setup(() => new Promise(() => {}));
        await environments.connect('dev@build-box');
        harnesses[0].hooks.update({ phase: 'probing' });

        const phaseChange = logger.write.mock.calls.find(
            (call) => call[1] === 'ssh_host.phase_changed',
        );
        expect(phaseChange).toMatchObject([
            'info',
            'ssh_host.phase_changed',
            { fields: { phase: 'probing', previousPhase: 'connecting' } },
        ]);
    });
});

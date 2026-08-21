import type { ChildProcess } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import {
    createChildExitPromise,
    createElectronLaunchSpec,
    createElectronStopController,
    waitForCdp,
} from '../start-electron';

class FakeChild {
    private readonly listeners = new Map<string, (...arguments_: unknown[]) => void>();
    exitCode: number | null = null;
    pid = 1234;
    kill = vi.fn();

    once(event: string, listener: (...arguments_: unknown[]) => void): this {
        this.listeners.set(event, listener);
        return this;
    }

    emit(event: string, ...arguments_: unknown[]): boolean {
        const listener = this.listeners.get(event);
        this.listeners.delete(event);
        listener?.(...arguments_);
        return Boolean(listener);
    }
}

function childProcess(fake = new FakeChild()): ChildProcess {
    return fake as unknown as ChildProcess;
}

describe('Acceptance Electron launcher seams', () => {
    it('builds a structured Electron launch with the isolated Acceptance environment', () => {
        const launch = createElectronLaunchSpec({
            electronPath: '/repo/node_modules/.bin/electron',
            environment: { PATH: '/usr/bin', CAXRI_E2E: 'old' },
            port: 9333,
            projectRoot: '/repo',
            testRootPath: '/project-one',
            testRootPaths: ['/project-one', '/project-two'],
            userDataDir: '/tmp/caxri-acceptance-user-case',
        });

        expect(launch).toEqual({
            args: ['.', '--remote-debugging-port=9333'],
            command: '/repo/node_modules/.bin/electron',
            options: {
                cwd: '/repo',
                env: {
                    PATH: '/usr/bin',
                    CAXRI_E2E: '1',
                    CAXRI_E2E_WINDOW_MODE: 'visible',
                    CAXRI_TEST_ROOT_PATH: '/project-one',
                    CAXRI_TEST_ROOT_PATHS: '["/project-one","/project-two"]',
                    CAXRI_USER_DATA_DIR: '/tmp/caxri-acceptance-user-case',
                },
                stdio: 'inherit',
            },
        });
    });

    it('reports both exit and spawn-error outcomes without launching a process', async () => {
        const exited = new FakeChild();
        const exit = createChildExitPromise(childProcess(exited));
        exited.emit('exit', 7, 'SIGTERM');
        await expect(exit).resolves.toEqual({ code: 7, signal: 'SIGTERM' });

        const failed = new FakeChild();
        const error = createChildExitPromise(childProcess(failed));
        failed.emit('error', new Error('spawn failed'));
        await expect(error).rejects.toThrow('spawn failed');
    });

    it('makes stop idempotent and escalates only after the force-stop delay', () => {
        const fake = new FakeChild();
        const unref = vi.fn();
        let forceStop: (() => void) | undefined;
        const scheduleForceStop = vi.fn((callback: () => void, milliseconds: number) => {
            expect(milliseconds).toBe(5_000);
            forceStop = callback;
            return { unref };
        });
        const controller = createElectronStopController(childProcess(fake), {
            isAlive: () => true,
            scheduleForceStop,
        });

        controller.stop();
        controller.stop();
        expect(controller.isStopping).toBe(true);
        expect(fake.kill).toHaveBeenCalledTimes(1);
        expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
        expect(scheduleForceStop).toHaveBeenCalledTimes(1);
        expect(unref).toHaveBeenCalledOnce();

        forceStop?.();
        expect(fake.kill).toHaveBeenLastCalledWith('SIGKILL');
    });

    it('waits for CDP readiness and fails closed on early exit or timeout', async () => {
        const readyChild = new FakeChild();
        const fetchProbe = vi
            .fn()
            .mockRejectedValueOnce(new Error('not listening'))
            .mockResolvedValueOnce({ ok: true });
        const sleep = vi.fn().mockResolvedValue(undefined);
        await expect(
            waitForCdp(9333, childProcess(readyChild), {
                fetch: fetchProbe as unknown as typeof fetch,
                now: () => 0,
                sleep,
            }),
        ).resolves.toBeUndefined();
        expect(fetchProbe).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(250);

        const exitedChild = new FakeChild();
        exitedChild.exitCode = 9;
        await expect(
            waitForCdp(9333, childProcess(exitedChild), {
                fetch: vi.fn() as unknown as typeof fetch,
                now: () => 0,
                sleep,
            }),
        ).rejects.toThrow('Electron exited before CDP became ready (9)');

        const timestamps = [0, 30_000];
        await expect(
            waitForCdp(9333, childProcess(), {
                fetch: vi.fn() as unknown as typeof fetch,
                now: () => timestamps.shift() ?? 30_000,
                sleep,
            }),
        ).rejects.toThrow('Timed out waiting for CDP on port 9333');
    });
});

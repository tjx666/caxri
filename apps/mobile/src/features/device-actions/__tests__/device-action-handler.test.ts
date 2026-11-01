import { DEVICE_EXEC_STREAM_MAX_JSON_BYTES } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { DeviceActionPorts } from '../device-action-handler';
import { runDeviceAction } from '../device-action-handler';
import { termuxSettingState } from '../termux-setting-model';

const exec = { kind: 'termuxExec' as const, argv: ['uname', '-a'], timeoutMs: 15_000 };

const ports = (overrides: Partial<DeviceActionPorts> = {}): DeviceActionPorts => ({
    isTermuxEnabled: () => Promise.resolve(true),
    openUrl: () => Promise.resolve(),
    runTermux: () =>
        Promise.resolve({
            status: 'exited',
            exitCode: 0,
            stdout: 'Linux\n',
            stderr: '',
            termuxTruncated: false,
        }),
    ...overrides,
});

describe('runDeviceAction', () => {
    it('opens a link and reports a refused one', async () => {
        const openUrl = vi.fn(() => Promise.resolve());
        await expect(
            runDeviceAction({ kind: 'openUrl', url: 'https://example.com' }, ports({ openUrl })),
        ).resolves.toEqual({ status: 'opened' });
        expect(openUrl).toHaveBeenCalledWith('https://example.com');
        await expect(
            runDeviceAction(
                { kind: 'openUrl', url: 'weird://x' },
                ports({ openUrl: () => Promise.reject(new Error('no handler')) }),
            ),
        ).resolves.toEqual({ status: 'failed', reason: 'open-failed' });
    });

    it('refuses Termux commands while the setting is off, without touching Termux', async () => {
        const runTermux = vi.fn();
        await expect(
            runDeviceAction(
                exec,
                ports({ isTermuxEnabled: () => Promise.resolve(false), runTermux }),
            ),
        ).resolves.toEqual({ status: 'failed', reason: 'disabled' });
        expect(runTermux).not.toHaveBeenCalled();
    });

    it('reports Termux commands as unsupported where the native module is absent', async () => {
        await expect(runDeviceAction(exec, ports({ runTermux: null }))).resolves.toEqual({
            status: 'failed',
            reason: 'unsupported',
        });
    });

    it('returns the command output and exit code', async () => {
        const runTermux = vi.fn(ports().runTermux!);
        await expect(
            runDeviceAction({ ...exec, cwd: '~/work' }, ports({ runTermux })),
        ).resolves.toEqual({
            status: 'exited',
            exitCode: 0,
            stdout: 'Linux\n',
            stderr: '',
            truncated: false,
        });
        expect(runTermux).toHaveBeenCalledWith(['uname', '-a'], '~/work', 15_000);
    });

    it('cuts oversized output to the frame budget and marks it truncated', async () => {
        const outcome = await runDeviceAction(
            exec,
            ports({
                runTermux: () =>
                    Promise.resolve({
                        status: 'exited',
                        exitCode: 0,
                        stdout: '中'.repeat(20_000),
                        stderr: 'warn',
                        termuxTruncated: false,
                    }),
            }),
        );
        expect(outcome).toMatchObject({ status: 'exited', stderr: 'warn', truncated: true });
        const stdout = outcome.status === 'exited' ? outcome.stdout : '';
        expect(new TextEncoder().encode(JSON.stringify(stdout)).length).toBeLessThanOrEqual(
            DEVICE_EXEC_STREAM_MAX_JSON_BYTES,
        );
    });

    it('keeps Termux’s own truncation and its failure reasons', async () => {
        await expect(
            runDeviceAction(
                exec,
                ports({
                    runTermux: () =>
                        Promise.resolve({
                            status: 'exited',
                            exitCode: 2,
                            stdout: '',
                            stderr: 'x',
                            termuxTruncated: true,
                        }),
                }),
            ),
        ).resolves.toMatchObject({ exitCode: 2, truncated: true });
        await expect(
            runDeviceAction(
                exec,
                ports({
                    runTermux: () =>
                        Promise.resolve({
                            status: 'failed',
                            reason: 'termux-error',
                            message: 'allow-external-apps is not true',
                        }),
                }),
            ),
        ).resolves.toEqual({
            status: 'failed',
            reason: 'termux-error',
            message: 'allow-external-apps is not true',
        });
        await expect(
            runDeviceAction(
                exec,
                ports({ runTermux: () => Promise.resolve({ status: 'failed', reason: 'novel' }) }),
            ),
        ).resolves.toEqual({ status: 'failed', reason: 'termux-error' });
        await expect(
            runDeviceAction(exec, ports({ runTermux: () => Promise.reject(new Error('binder')) })),
        ).resolves.toEqual({ status: 'failed', reason: 'termux-error', message: 'binder' });
    });
});

describe('termuxSettingState', () => {
    const facts = { isSupported: true, isInstalled: true, isEnabled: true, hasPermission: true };

    it('is on only when installed, chosen, and permitted', () => {
        expect(termuxSettingState(facts)).toBe('on');
        expect(termuxSettingState({ ...facts, hasPermission: false })).toBe('off');
        expect(termuxSettingState({ ...facts, isEnabled: false })).toBe('off');
        expect(termuxSettingState({ ...facts, isInstalled: false })).toBe('missing');
        expect(termuxSettingState({ ...facts, isSupported: false })).toBe('unsupported');
    });
});

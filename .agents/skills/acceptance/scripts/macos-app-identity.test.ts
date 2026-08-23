import { describe, expect, it, vi } from 'vitest';

import {
    createMacosAcceptanceAppPlan,
    findMacosAcceptanceProcessIds,
    prepareMacosAcceptanceApp,
    stopMacosAcceptanceProcesses,
} from './macos-app-identity';

describe('macOS Acceptance app identity', () => {
    it('gives each launch a unique app and helper bundle identity', () => {
        const plan = createMacosAcceptanceAppPlan({
            caseId: 'terminal-link-keyboard-01',
            nonce: '4ba0d1b8-0123-4567-89ab-cdef01234567',
            sourceAppPath: '/repo/node_modules/electron/dist/Electron.app',
            userDataDir: '/tmp/caxri-acceptance-user-terminal-link-keyboard-01',
        });

        expect(plan).toMatchObject({
            appName: 'Caxri Acceptance 4ba0d1b8',
            appPath:
                '/tmp/caxri-acceptance-user-terminal-link-keyboard-01/apps.noindex/Caxri Acceptance 4ba0d1b8.app',
            bundleId:
                'dev.caxri.acceptance.terminal-link-keyboard-01.4ba0d1b80123456789abcdef01234567',
            executablePath:
                '/tmp/caxri-acceptance-user-terminal-link-keyboard-01/apps.noindex/Caxri Acceptance 4ba0d1b8.app/Contents/MacOS/Electron',
        });
        expect(plan.plists).toHaveLength(5);
        expect(plan.plists[0]).toMatchObject({
            bundleId: plan.bundleId,
            displayNameOperation: '-replace',
            name: plan.appName,
        });
        expect(plan.plists.slice(1)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    bundleId: `${plan.bundleId}.helper`,
                    displayNameOperation: '-insert',
                }),
            ]),
        );
        expect(plan.plists.every(({ bundleId }) => bundleId !== 'com.github.Electron')).toBe(true);
    });

    it('clones and re-identifies the bundle without changing Electron development semantics', async () => {
        const makeDirectory = vi.fn().mockResolvedValue(undefined);
        const execute = vi.fn((command: string, arguments_: string[]) =>
            Promise.resolve({
                stderr: '',
                stdout:
                    command === '/usr/bin/plutil' && arguments_[0] === '-extract'
                        ? 'dev.caxri.acceptance.keyboard-case.0123456789abcdef0123456789abcdef\n'
                        : '',
            }),
        );

        const prepared = await prepareMacosAcceptanceApp(
            {
                caseId: 'keyboard-case',
                sourceAppPath: '/repo/Electron.app',
                userDataDir: '/tmp/profile',
            },
            {
                execute,
                makeDirectory,
                nonce: () => '01234567-89ab-cdef-0123-456789abcdef',
            },
        );

        expect(makeDirectory).toHaveBeenCalledWith('/tmp/profile/apps.noindex');
        expect(execute).toHaveBeenNthCalledWith(1, '/bin/cp', [
            '-cR',
            '/repo/Electron.app',
            '/tmp/profile/apps.noindex/Caxri Acceptance 01234567.app',
        ]);
        expect(execute).not.toHaveBeenCalledWith('/bin/mv', expect.anything());
        expect(execute).not.toHaveBeenCalledWith(
            '/usr/bin/plutil',
            expect.arrayContaining(['CFBundleExecutable']),
        );
        expect(execute).toHaveBeenCalledWith('/usr/bin/plutil', [
            '-replace',
            'CFBundleIdentifier',
            '-string',
            prepared.bundleId,
            '/tmp/profile/apps.noindex/Caxri Acceptance 01234567.app/Contents/Info.plist',
        ]);
        expect(execute).toHaveBeenCalledWith('/usr/bin/plutil', [
            '-extract',
            'CFBundleIdentifier',
            'raw',
            '/tmp/profile/apps.noindex/Caxri Acceptance 01234567.app/Contents/Info.plist',
        ]);
        expect(execute).toHaveBeenLastCalledWith('/usr/bin/codesign', [
            '--force',
            '--deep',
            '--sign',
            '-',
            prepared.appPath,
        ]);
        expect(prepared.executablePath).toBe(
            '/tmp/profile/apps.noindex/Caxri Acceptance 01234567.app/Contents/MacOS/Electron',
        );
    });

    it('finds only the main process launched from the unique temporary app path', () => {
        const executablePath = '/tmp/profile/Caxri Acceptance 01234567.app/Contents/MacOS/Electron';
        expect(
            findMacosAcceptanceProcessIds(
                [
                    `  41 ${executablePath} /repo --remote-debugging-port=9222`,
                    '  42 /repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .',
                    `  43 ${executablePath} Helper --type=renderer`,
                ].join('\n'),
                executablePath,
            ),
        ).toEqual([41]);
    });

    it('terminates and confirms every process from an undiscovered unique app launch', async () => {
        const executablePath = '/tmp/profile/apps.noindex/Caxri.app/Contents/MacOS/Electron';
        const signalProcess = vi.fn();
        const listProcesses = vi
            .fn()
            .mockResolvedValueOnce(`41 ${executablePath} /repo --remote-debugging-port=9222`)
            .mockResolvedValueOnce('');

        await expect(
            stopMacosAcceptanceProcesses(executablePath, {
                listProcesses,
                now: () => 0,
                signalProcess,
                sleep: vi.fn().mockResolvedValue(undefined),
            }),
        ).resolves.toEqual([41]);
        expect(signalProcess).toHaveBeenCalledWith(41, 'SIGTERM');
        expect(signalProcess).not.toHaveBeenCalledWith(41, 'SIGKILL');
    });

    it('terminates a unique app that appears after the first cleanup snapshot', async () => {
        const executablePath = '/tmp/profile/apps.noindex/Caxri.app/Contents/MacOS/Electron';
        const signalProcess = vi.fn();
        const listProcesses = vi
            .fn()
            .mockResolvedValueOnce('')
            .mockResolvedValueOnce(`41 ${executablePath} /repo --remote-debugging-port=9222`)
            .mockResolvedValueOnce('');

        await expect(
            stopMacosAcceptanceProcesses(executablePath, {
                listProcesses,
                now: () => 0,
                signalProcess,
                sleep: vi.fn().mockResolvedValue(undefined),
            }),
        ).resolves.toEqual([41]);
        expect(signalProcess).toHaveBeenCalledWith(41, 'SIGTERM');
    });
});

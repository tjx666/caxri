import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { App } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    configureDesktopProfile,
    hasProfileSingleInstanceLock,
    installSecondInstanceFocus,
} from '../desktop-profile';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { force: true, recursive: true })));
});

interface FakeAppOptions {
    appDataPath: string;
    isPackaged?: boolean;
    remoteDebuggingPort?: string;
    remoteDebuggingPipe?: boolean;
    userDataPath: string;
}

function createFakeApp(options: FakeAppOptions) {
    const appended: Array<{ key: string; value?: string }> = [];
    const listeners = new Map<string, (...arguments_: unknown[]) => void>();
    const paths = new Map([
        ['appData', options.appDataPath],
        ['userData', options.userDataPath],
    ]);
    const requestSingleInstanceLock = vi.fn(() => true);
    const app = {
        commandLine: {
            appendSwitch: (key: string, value?: string) => appended.push({ key, value }),
            getSwitchValue: (key: string) =>
                key === 'remote-debugging-port' ? (options.remoteDebuggingPort ?? '') : '',
            hasSwitch: (key: string) =>
                (key === 'remote-debugging-port' && options.remoteDebuggingPort !== undefined) ||
                (key === 'remote-debugging-pipe' && options.remoteDebuggingPipe === true),
        },
        getPath: (name: string) => paths.get(name),
        isPackaged: options.isPackaged ?? false,
        on: (event: string, listener: (...arguments_: unknown[]) => void) => {
            listeners.set(event, listener);
        },
        requestSingleInstanceLock,
        setPath: (name: string, value: string) => paths.set(name, value),
    } as unknown as App;
    return {
        app,
        appended,
        emit: (event: string) => listeners.get(event)?.(),
        requestSingleInstanceLock,
    };
}

async function temporaryDirectory(prefix: string): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), prefix));
    temporaryDirectories.push(path);
    return path;
}

describe('runtime profile authority', () => {
    it('derives development userData, logs, CDP, and identity from one canonical profile', async () => {
        const root = await temporaryDirectory('caxri-desktop-profile-');
        const appDataPath = join(root, 'application-data');
        const { app, appended } = createFakeApp({
            appDataPath,
            userDataPath: join(root, 'electron-default'),
        });

        const profile = configureDesktopProfile(app, {});
        const expectedUserDataPath = await realpath(join(appDataPath, 'caxri-dev'));

        expect(profile).toMatchObject({
            kind: 'development-default',
            logDirectory: join(expectedUserDataPath, 'logs'),
            remoteDebugging: {
                port: '9223',
                source: 'profile-default',
                transport: 'port',
            },
            userDataPath: expectedUserDataPath,
        });
        expect(profile.id).toMatch(/^[a-f\d]{24}$/u);
        expect(app.getPath('userData')).toBe(profile.userDataPath);
        expect(appended).toEqual([{ key: 'remote-debugging-port', value: '9223' }]);
    });

    it('canonicalizes explicit aliases into the same profile identity', async () => {
        const root = await temporaryDirectory('caxri-desktop-profile-alias-');
        const profileDirectory = join(root, 'profile');
        const alias = join(root, 'profile-alias');
        await mkdir(profileDirectory);
        await symlink(profileDirectory, alias);
        const first = createFakeApp({
            appDataPath: root,
            userDataPath: join(root, 'electron-default'),
        });
        const second = createFakeApp({
            appDataPath: root,
            userDataPath: join(root, 'electron-default'),
        });

        const direct = configureDesktopProfile(first.app, {
            CAXRI_USER_DATA_DIR: profileDirectory,
        });
        const aliased = configureDesktopProfile(second.app, { CAXRI_USER_DATA_DIR: alias });

        expect(aliased.userDataPath).toBe(await realpath(profileDirectory));
        expect(aliased.id).toBe(direct.id);
        expect(aliased.logDirectory).toBe(join(direct.userDataPath, 'logs'));
    });

    it('keeps different explicit canonical profiles as independent identities', async () => {
        const root = await temporaryDirectory('caxri-desktop-profile-independent-');
        const first = createFakeApp({
            appDataPath: root,
            userDataPath: join(root, 'electron-default'),
        });
        const second = createFakeApp({
            appDataPath: root,
            userDataPath: join(root, 'electron-default'),
        });

        const firstProfile = configureDesktopProfile(first.app, {
            CAXRI_USER_DATA_DIR: join(root, 'first-profile'),
        });
        const secondProfile = configureDesktopProfile(second.app, {
            CAXRI_USER_DATA_DIR: join(root, 'second-profile'),
        });

        expect(secondProfile.userDataPath).not.toBe(firstProfile.userDataPath);
        expect(secondProfile.id).not.toBe(firstProfile.id);
        expect(secondProfile.logDirectory).not.toBe(firstProfile.logDirectory);
    });

    it('retains an explicit CDP switch as part of the profile identity without replacing it', async () => {
        const root = await temporaryDirectory('caxri-desktop-profile-switch-');
        const { app, appended } = createFakeApp({
            appDataPath: root,
            remoteDebuggingPort: '9333',
            userDataPath: join(root, 'profile'),
        });

        const profile = configureDesktopProfile(app, {});

        expect(profile.remoteDebugging).toEqual({
            port: '9333',
            source: 'command-line',
            transport: 'port',
        });
        expect(appended).toEqual([]);
    });

    it('honors the packaged profile argv gate after selecting the canonical userData path', async () => {
        const root = await temporaryDirectory('caxri-desktop-profile-packaged-');
        const profileDirectory = join(root, 'profile');
        await mkdir(join(profileDirectory, 'config'), { recursive: true });
        await writeFile(
            join(profileDirectory, 'config', 'argv.jsonc'),
            '{ "remoteDebugging": false }',
            'utf8',
        );
        const { app, appended } = createFakeApp({
            appDataPath: root,
            isPackaged: true,
            userDataPath: profileDirectory,
        });

        const profile = configureDesktopProfile(app, {});

        expect(profile).toMatchObject({
            kind: 'packaged-default',
            remoteDebugging: { source: 'argv-config', transport: 'disabled' },
            userDataPath: await realpath(profileDirectory),
        });
        expect(appended).toEqual([]);
    });
});

describe('profile single instance', () => {
    it('keys the Electron lock with the resolved profile identity', async () => {
        const root = await temporaryDirectory('caxri-desktop-profile-lock-');
        const fixture = createFakeApp({
            appDataPath: root,
            userDataPath: join(root, 'profile'),
        });
        const profile = configureDesktopProfile(fixture.app, {});

        expect(hasProfileSingleInstanceLock(fixture.app, profile)).toBe(true);
        expect(fixture.requestSingleInstanceLock).toHaveBeenCalledWith({ profileId: profile.id });
    });

    it('queues an early second-instance focus until the Desktop is ready', async () => {
        const root = await temporaryDirectory('caxri-desktop-profile-focus-');
        const fixture = createFakeApp({
            appDataPath: root,
            userDataPath: join(root, 'profile'),
        });
        const focus = vi.fn(() => Promise.resolve());
        const onError = vi.fn();
        const controller = installSecondInstanceFocus(fixture.app, focus, onError);

        fixture.emit('second-instance');
        expect(focus).not.toHaveBeenCalled();

        controller.ready();
        await vi.waitFor(() => expect(focus).toHaveBeenCalledTimes(1));
        fixture.emit('second-instance');
        await vi.waitFor(() => expect(focus).toHaveBeenCalledTimes(2));
        expect(onError).not.toHaveBeenCalled();
    });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: {}, dialog: {} }));

const { launchLocationKind, offerMoveToAppsWith, shouldOfferMoveToApps } =
    await import('../move-to-apps');

const base = {
    executablePath: '/Volumes/Caxri/Caxri.app/Contents/MacOS/Caxri',
    isInApplicationsFolder: false,
    isPackaged: true,
    platform: 'darwin' as const,
};

describe('shouldOfferMoveToApps', () => {
    it('offers for a packaged macOS build outside Applications', () => {
        expect(shouldOfferMoveToApps(base)).toBe(true);
    });

    it('stays quiet in Applications, unpackaged builds, and other platforms', () => {
        expect(shouldOfferMoveToApps({ ...base, isInApplicationsFolder: true })).toBe(false);
        expect(shouldOfferMoveToApps({ ...base, isPackaged: false })).toBe(false);
        expect(shouldOfferMoveToApps({ ...base, platform: 'linux' })).toBe(false);
    });

    it('stays quiet when the user keeps Caxri outside Applications on purpose', () => {
        expect(
            shouldOfferMoveToApps({
                ...base,
                downloadsDirectory: '/Users/someone/Downloads',
                executablePath: '/Users/someone/dev/Caxri.app/Contents/MacOS/Caxri',
            }),
        ).toBe(false);
    });

    it('offers from App Translocation and the Downloads folder', () => {
        expect(
            shouldOfferMoveToApps({
                ...base,
                executablePath: '/private/var/AppTranslocation/ABC/d/Caxri.app/x',
            }),
        ).toBe(true);
        expect(
            shouldOfferMoveToApps({
                ...base,
                downloadsDirectory: '/Users/someone/Downloads',
                executablePath: '/Users/someone/Downloads/Caxri.app/x',
            }),
        ).toBe(true);
    });
});

describe('launchLocationKind', () => {
    it('names the disk image and translocation cases', () => {
        expect(launchLocationKind('/Volumes/Caxri/Caxri.app/x')).toBe('dmg');
        expect(launchLocationKind('/private/var/AppTranslocation/ABC/d/Caxri.app/x')).toBe(
            'translocated',
        );
        expect(launchLocationKind('/Users/someone/Downloads/Caxri.app/x')).toBe('other');
        expect(
            launchLocationKind('/Users/someone/Downloads/Caxri.app/x', '/Users/someone/Downloads'),
        ).toBe('downloads');
    });
});

describe('offerMoveToAppsWith', () => {
    let userDataPath: string;
    beforeEach(async () => {
        vi.resetModules();
        userDataPath = await mkdtemp(join(tmpdir(), 'move-to-apps-'));
    });
    afterEach(() => rm(userDataPath, { force: true, recursive: true }));

    async function run(
        response: number,
        moved: boolean | Error,
        version = '1.0.0',
        offer = offerMoveToAppsWith,
    ) {
        const options = {
            prepareRelaunch: vi.fn(),
            restoreQuitIntent: vi.fn(),
            userDataPath,
        };
        const showPrompt = vi.fn(() => Promise.resolve(response));
        const moveToAppsFolder = vi.fn(() => {
            if (moved instanceof Error) throw moved;
            return moved;
        });
        await offer(options, {
            downloadsDirectory: '/Users/someone/Downloads',
            executablePath: base.executablePath,
            isE2E: false,
            isInApplicationsFolder: false,
            isPackaged: true,
            moveToApplicationsFolder: moveToAppsFolder,
            platform: 'darwin',
            showPrompt,
            version,
        });
        return { moveToApplicationsFolder: moveToAppsFolder, options, showPrompt };
    }

    it('sets the relaunch intent before moving and keeps it when the move succeeds', async () => {
        const { offerMoveToAppsWith: offer } = await import('../move-to-apps');
        const { moveToApplicationsFolder, options } = await run(0, true, '1.0.0', offer);
        expect(options.prepareRelaunch).toHaveBeenCalledBefore(moveToApplicationsFolder);
        expect(options.restoreQuitIntent).not.toHaveBeenCalled();
    });

    it.each([false, new Error('refused')])(
        'restores the quit intent when the move is %s',
        async (moved) => {
            const { offerMoveToAppsWith: offer } = await import('../move-to-apps');
            const { options } = await run(0, moved, '1.0.0', offer);
            expect(options.prepareRelaunch).toHaveBeenCalledOnce();
            expect(options.restoreQuitIntent).toHaveBeenCalledOnce();
        },
    );

    it('remembers Not Now for the app version and asks again for a newer one', async () => {
        const first = await import('../move-to-apps');
        const declined = await run(1, true, '1.0.0', first.offerMoveToAppsWith);
        expect(declined.moveToApplicationsFolder).not.toHaveBeenCalled();
        const stored = await readFile(join(userDataPath, 'move-to-applications.json'), 'utf8');
        expect(JSON.parse(stored)).toEqual({ declinedVersion: '1.0.0' });

        vi.resetModules();
        const second = await import('../move-to-apps');
        const sameVersion = await run(1, true, '1.0.0', second.offerMoveToAppsWith);
        expect(sameVersion.showPrompt).not.toHaveBeenCalled();

        vi.resetModules();
        const third = await import('../move-to-apps');
        const newer = await run(1, true, '1.1.0', third.offerMoveToAppsWith);
        expect(newer.showPrompt).toHaveBeenCalledOnce();
    });
});

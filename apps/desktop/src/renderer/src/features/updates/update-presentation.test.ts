import type { UpdateState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../i18n';
import {
    canRetryUpdateCheck,
    describeUpdateChip,
    describeUpdateStatus,
    releaseNotesTarget,
    releaseNotesUrl,
    resolveAutomaticDownload,
    resolveReadyAnnouncement,
    resolveUpdatedNotice,
    resolveUpdatePrimaryAction,
    shouldExplainUnsignedInstall,
    updateRetryTimeLabel,
} from './update-presentation';

const available: UpdateState = {
    status: 'available',
    currentVersion: '1.0.0',
    version: '1.1.0',
    fileName: 'Caxri-1.1.0-arm64.dmg',
};

const ready: UpdateState = {
    status: 'ready',
    currentVersion: '1.0.0',
    version: '1.1.0',
    fileName: 'Caxri-1.1.0-arm64.dmg',
    installMode: 'restart',
};

describe('resolveAutomaticDownload', () => {
    it('downloads a release this process has not offered yet', () => {
        expect(resolveAutomaticDownload(available, null)).toBe('1.1.0');
    });

    it('stays put once this process has offered the release, so a cancelled download stays cancelled', () => {
        expect(resolveAutomaticDownload({ ...available, announced: true }, null)).toBeUndefined();
    });

    it('never downloads the skipped version or anything it already covers', () => {
        expect(resolveAutomaticDownload(available, '1.1.0')).toBeUndefined();
        expect(resolveAutomaticDownload(available, '1.2.0')).toBeUndefined();
    });

    it('downloads again once a version newer than the skipped one appears', () => {
        expect(resolveAutomaticDownload({ ...available, version: '1.2.0' }, '1.1.0')).toBe('1.2.0');
    });

    it('falls back to exact matching for a hand-edited skip it cannot parse', () => {
        expect(resolveAutomaticDownload(available, 'not-a-version')).toBe('1.1.0');
        expect(
            resolveAutomaticDownload({ ...available, version: 'nightly' }, 'nightly'),
        ).toBeUndefined();
    });

    it('acts on nothing but an available release', () => {
        expect(
            resolveAutomaticDownload({ status: 'up-to-date', currentVersion: '1.0.0' }, null),
        ).toBeUndefined();
        expect(resolveAutomaticDownload(ready, null)).toBeUndefined();
        expect(resolveAutomaticDownload(undefined, null)).toBeUndefined();
    });
});

describe('resolveReadyAnnouncement', () => {
    it('offers the restart for an update Main has unpacked', () => {
        expect(resolveReadyAnnouncement(ready)).toEqual({
            version: '1.1.0',
            mode: 'restart',
            message: 'Caxri 1.1.0 is ready. Restart to finish updating.',
        });
    });

    it('points a manual install at the dialog instead', () => {
        expect(resolveReadyAnnouncement({ ...ready, installMode: 'manual' })).toEqual({
            version: '1.1.0',
            mode: 'manual',
            message: 'Caxri 1.1.0 is downloaded and verified.',
        });
    });

    it('warns that a data-resetting update clears Projects and Sessions everywhere it is offered', () => {
        const resetting: UpdateState = { ...ready, resetsData: true };
        expect(resolveReadyAnnouncement(resetting)?.message).toBe(
            'Caxri 1.1.0 is ready. It clears your Projects and Sessions, so export them before restarting to update.',
        );
        expect(describeUpdateChip(resetting, '1.1.0', translate)?.description).toBe(
            'Caxri 1.1.0 is ready and clears your Projects and Sessions. Click to export them and update.',
        );
        expect(describeUpdateStatus(resetting, { t: translate }).description).toMatch(
            /clears the Project and Session list.*quitting Caxri does not install it/u,
        );
    });

    it('announces once per process and only for a ready update', () => {
        expect(resolveReadyAnnouncement({ ...ready, announced: true })).toBeUndefined();
        expect(resolveReadyAnnouncement(available)).toBeUndefined();
        expect(resolveReadyAnnouncement(undefined)).toBeUndefined();
    });
});

describe('describeUpdateChip', () => {
    it('names the available release and drops it once skipped', () => {
        expect(describeUpdateChip(available, null, translate)?.label).toBe('Update 1.1.0');
        expect(describeUpdateChip(available, '1.1.0', translate)).toBeUndefined();
    });

    it('keeps an announced release on the chip, because Close is not a skip', () => {
        expect(describeUpdateChip({ ...available, announced: true }, null, translate)?.kind).toBe(
            'available',
        );
    });

    it('reports download progress, and omits the percentage without a known total', () => {
        expect(
            describeUpdateChip(
                {
                    status: 'downloading',
                    currentVersion: '1.0.0',
                    version: '1.1.0',
                    fileName: 'Caxri-1.1.0-arm64.dmg',
                    receivedBytes: 25,
                    totalBytes: 100,
                },
                null,
                translate,
            ),
        ).toEqual({
            label: 'Updating 25%',
            description: 'Downloading Caxri 1.1.0. Click to show the download.',
            kind: 'downloading',
        });
        expect(
            describeUpdateChip(
                {
                    status: 'downloading',
                    currentVersion: '1.0.0',
                    version: '1.1.0',
                    fileName: 'Caxri-1.1.0-arm64.dmg',
                    receivedBytes: 25,
                },
                null,
                translate,
            )?.label,
        ).toBe('Updating…');
    });

    it('keeps a failed download reachable, naming what broke', () => {
        expect(
            describeUpdateChip(
                {
                    status: 'error',
                    failureKind: 'other',
                    currentVersion: '1.0.0',
                    version: '1.1.0',
                    action: 'download',
                    message: 'net::ERR_CONNECTION_RESET',
                },
                null,
                translate,
            ),
        ).toEqual({
            label: 'Update failed',
            description: 'Caxri 1.1.0 could not be downloaded. Click to see why and try again.',
            kind: 'failed',
        });
        expect(
            describeUpdateChip(
                {
                    status: 'error',
                    failureKind: 'other',
                    currentVersion: '1.0.0',
                    version: '1.1.0',
                    action: 'open',
                    message: 'The disk image could not be opened.',
                },
                null,
                translate,
            )?.description,
        ).toContain('could not be installed');
    });

    it('leaves a failed background check off the status bar', () => {
        expect(
            describeUpdateChip(
                {
                    status: 'error',
                    failureKind: 'other',
                    currentVersion: '1.0.0',
                    action: 'check',
                    message: 'GitHub is unreachable.',
                },
                null,
                translate,
            ),
        ).toBeUndefined();
    });

    it('keeps the download and install chips visible even for a skipped version', () => {
        expect(
            describeUpdateChip(
                {
                    status: 'downloading',
                    currentVersion: '1.0.0',
                    version: '1.1.0',
                    fileName: 'Caxri-1.1.0-arm64.dmg',
                    receivedBytes: 25,
                    totalBytes: 100,
                },
                '1.1.0',
                translate,
            )?.kind,
        ).toBe('downloading');
        expect(describeUpdateChip({ ...ready, installMode: 'manual' }, '1.1.0', translate)).toEqual(
            {
                label: 'Update ready',
                description: 'Caxri 1.1.0 is downloaded and verified. Click to continue.',
                kind: 'ready',
            },
        );
        expect(describeUpdateChip(ready, '1.1.0', translate)).toEqual({
            label: 'Restart to update',
            description: 'Caxri 1.1.0 is ready. Click to restart and finish updating.',
            kind: 'ready',
        });
    });

    it('shows nothing for the transient and healthy statuses', () => {
        expect(describeUpdateChip(undefined, null, translate)).toBeUndefined();
        expect(
            describeUpdateChip({ status: 'idle', currentVersion: '1.0.0' }, null, translate),
        ).toBeUndefined();
        expect(
            describeUpdateChip({ status: 'checking', currentVersion: '1.0.0' }, null, translate),
        ).toBeUndefined();
        expect(
            describeUpdateChip({ status: 'up-to-date', currentVersion: '1.0.0' }, null, translate),
        ).toBeUndefined();
        expect(
            describeUpdateChip(
                {
                    status: 'error',
                    failureKind: 'other',
                    currentVersion: '1.0.0',
                    action: 'check',
                    message: 'Nope.',
                },
                null,
                translate,
            ),
        ).toBeUndefined();
    });
});

describe('updateRetryTimeLabel', () => {
    const noon = Date.UTC(2026, 0, 2, 12, 0, 0);

    it('names the clock time a paused check resumes at', () => {
        expect(updateRetryTimeLabel(noon + 600_000, 'en', noon)).toMatch(/^\d{1,2}:\d{2}/u);
    });

    it('returns nothing for a deadline that already passed or was never reported', () => {
        expect(updateRetryTimeLabel(noon - 1, 'en', noon)).toBeUndefined();
        expect(updateRetryTimeLabel(undefined, 'en', noon)).toBeUndefined();
        expect(updateRetryTimeLabel(NaN, 'en', noon)).toBeUndefined();
    });
});

describe('describeUpdateStatus', () => {
    const rateLimited: UpdateState = {
        status: 'unavailable',
        currentVersion: '1.0.0',
        reason: 'Update checks are rate limited by GitHub right now.',
        rateLimited: true,
        retryAt: Date.UTC(2026, 0, 2, 12, 10, 0),
    };
    const now = Date.UTC(2026, 0, 2, 12, 0, 0);

    it('names the resume time and says a manual check does not wait for it', () => {
        const copy = describeUpdateStatus(rateLimited, { now, t: translate });
        expect(copy.title).toBe('Update checks are paused');
        expect(copy.description).toContain('Automatic checks resume after');
        expect(copy.description).toContain('without waiting');
    });

    it('still explains the pause when GitHub reported no deadline', () => {
        const copy = describeUpdateStatus(
            { ...rateLimited, retryAt: undefined },
            { now, t: translate },
        );
        expect(copy.description).toContain('resume once the limit clears');
        expect(copy.description).toContain('without waiting');
    });

    it('does not promise a resume time that already passed', () => {
        const copy = describeUpdateStatus(rateLimited, { now: rateLimited.retryAt, t: translate });
        expect(copy.description).toContain('resume once the limit clears');
    });

    it('leaves a non-rate-limited unavailable state on its own reason', () => {
        expect(
            describeUpdateStatus(
                {
                    status: 'unavailable',
                    currentVersion: '1.0.0',
                    reason: 'Update checks are available in packaged Caxri builds.',
                },
                { t: translate },
            ),
        ).toEqual({
            title: 'Update checks unavailable',
            description: 'Update checks are available in packaged Caxri builds.',
        });
    });

    it('explains why a skipped release is not being offered', () => {
        expect(
            describeUpdateStatus(available, { skippedVersion: '1.1.0', t: translate }).description,
        ).toContain('You skipped this version');
        expect(
            describeUpdateStatus(available, { skippedVersion: null, t: translate }).description,
        ).toContain('Download Caxri-1.1.0-arm64.dmg');
    });
});

describe('resolveUpdatePrimaryAction', () => {
    const failed = (action: 'check' | 'download' | 'install' | 'open'): UpdateState => ({
        status: 'error',
        failureKind: 'other',
        currentVersion: '1.0.0',
        action,
        message: 'Failed.',
    });

    it('offers Restart to Update only for a staged update and the DMG otherwise', () => {
        expect(resolveUpdatePrimaryAction(ready, false)).toBe('install');
        expect(resolveUpdatePrimaryAction({ ...ready, installMode: 'manual' }, false)).toBe(
            'openDmg',
        );
    });

    it('retries the step that failed', () => {
        expect(resolveUpdatePrimaryAction(failed('install'), false)).toBe('retryInstall');
        expect(resolveUpdatePrimaryAction(failed('open'), false)).toBe('openDmg');
        expect(resolveUpdatePrimaryAction(failed('download'), false)).toBe('retryDownload');
        expect(resolveUpdatePrimaryAction(failed('check'), false)).toBe('check');
    });

    it('lets a skipped release be un-skipped instead of downloaded', () => {
        expect(resolveUpdatePrimaryAction(available, true)).toBe('stopSkipping');
        expect(resolveUpdatePrimaryAction(available, false)).toBe('download');
        expect(resolveUpdatePrimaryAction(undefined, false)).toBe('checking');
    });
});

describe('canRetryUpdateCheck', () => {
    it('keeps the action live under a rate limit, because a manual check bypasses the window', () => {
        expect(
            canRetryUpdateCheck({
                status: 'unavailable',
                currentVersion: '1.0.0',
                reason: 'Update checks are rate limited by GitHub right now.',
                rateLimited: true,
            }),
        ).toBe(true);
    });

    it('disables it only for a cause retrying cannot fix', () => {
        expect(
            canRetryUpdateCheck({
                status: 'unavailable',
                currentVersion: '1.0.0',
                reason: 'Update checks are available in packaged Caxri builds.',
            }),
        ).toBe(false);
    });
});

describe('shouldExplainUnsignedInstall', () => {
    it('explains the manual install once replacing the app by hand is the next step', () => {
        expect(shouldExplainUnsignedInstall({ ...ready, installMode: 'manual' })).toBe(true);
        // A failed download or restart leaves the DMG as the fallback, so the instructions stay useful.
        expect(
            shouldExplainUnsignedInstall({
                status: 'error',
                failureKind: 'other',
                currentVersion: '1.0.0',
                action: 'download',
                version: '1.1.0',
                message: 'Download interrupted.',
            }),
        ).toBe(true);
    });

    it('stays out of the way while the update can still restart into itself', () => {
        expect(shouldExplainUnsignedInstall(available)).toBe(false);
        expect(
            shouldExplainUnsignedInstall({
                status: 'downloading',
                currentVersion: '1.0.0',
                version: '1.1.0',
                fileName: 'Caxri-1.1.0-arm64.dmg',
                receivedBytes: 1,
                totalBytes: 2,
            }),
        ).toBe(false);
        expect(shouldExplainUnsignedInstall(ready)).toBe(false);
    });

    it('stays quiet when there is nothing to install', () => {
        expect(shouldExplainUnsignedInstall(undefined)).toBe(false);
        expect(shouldExplainUnsignedInstall({ status: 'checking', currentVersion: '1.0.0' })).toBe(
            false,
        );
        expect(
            shouldExplainUnsignedInstall({ status: 'up-to-date', currentVersion: '1.0.0' }),
        ).toBe(false);
        // A check that failed before naming a version has no DMG to talk about.
        expect(
            shouldExplainUnsignedInstall({
                status: 'error',
                failureKind: 'other',
                currentVersion: '1.0.0',
                action: 'check',
                message: 'GitHub is unreachable.',
            }),
        ).toBe(false);
    });
});

describe('update failure recovery copy', () => {
    it('keeps raw transport diagnostics out of the recovery message', () => {
        const state: UpdateState = {
            status: 'error',
            failureKind: 'other',
            currentVersion: '1.0.0',
            action: 'download',
            message: 'net::ERR_CONNECTION_RESET',
        };
        const copy = describeUpdateStatus(state, { t: translate });
        expect(copy.description).not.toContain('ERR_CONNECTION_RESET');
        expect(copy.description).toContain('try again');
    });
});

it('explains network and integrity failures separately', () => {
    const base = {
        status: 'error',
        currentVersion: '1.0.0',
        action: 'download',
        message: 'internal',
    } as const;
    expect(
        describeUpdateStatus({ ...base, failureKind: 'network' }, { t: translate }).description,
    ).toContain('Check your network');
    expect(
        describeUpdateStatus({ ...base, failureKind: 'integrity' }, { t: translate }).description,
    ).toContain('was not opened');
});

describe('release notes', () => {
    it('prefers the release page from Main and falls back to the tag page', () => {
        expect(releaseNotesUrl('1.1.0')).toBe(
            'https://github.com/tjx666/caxri/releases/tag/v1.1.0',
        );
        expect(releaseNotesUrl('1.1.0', 'https://github.com/tjx666/caxri/releases/tag/x')).toBe(
            'https://github.com/tjx666/caxri/releases/tag/x',
        );
    });

    it('targets a release only while one is in play', () => {
        expect(releaseNotesTarget(available)?.version).toBe('1.1.0');
        expect(
            releaseNotesTarget({ status: 'up-to-date', currentVersion: '1.0.0' }),
        ).toBeUndefined();
        expect(releaseNotesTarget(undefined)).toBeUndefined();
    });

    it('raises the updated notice only when Main reports a replaced version', () => {
        expect(resolveUpdatedNotice({ status: 'idle', currentVersion: '1.1.0' })).toBeUndefined();
        expect(
            resolveUpdatedNotice({ status: 'idle', currentVersion: '1.1.0', updatedFrom: '1.0.0' }),
        ).toMatchObject({ version: '1.1.0' });
    });
});

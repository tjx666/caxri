import type { UpdateState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    canRetryUpdateCheck,
    describeUpdateChip,
    describeUpdateStatus,
    releaseNotesTarget,
    releaseNotesUrl,
    resolveUpdateAnnouncement,
    resolveUpdatedNotice,
    shouldExplainUnsignedInstall,
    updateRetryTimeLabel,
} from './update-presentation';

const available: UpdateState = {
    status: 'available',
    currentVersion: '1.0.0',
    version: '1.1.0',
    fileName: 'Caxri-1.1.0-arm64.dmg',
};

describe('resolveUpdateAnnouncement', () => {
    it('announces a release this process has not offered yet', () => {
        expect(resolveUpdateAnnouncement(available, null)).toEqual({
            version: '1.1.0',
            message: 'Caxri 1.1.0 is available. You are running 1.0.0.',
        });
    });

    it('stays silent once this process has announced the release', () => {
        expect(resolveUpdateAnnouncement({ ...available, announced: true }, null)).toBeUndefined();
    });

    it('stays silent for the skipped version and for anything it already covers', () => {
        expect(resolveUpdateAnnouncement(available, '1.1.0')).toBeUndefined();
        expect(resolveUpdateAnnouncement(available, '1.2.0')).toBeUndefined();
    });

    it('announces again once a version newer than the skipped one appears', () => {
        expect(resolveUpdateAnnouncement({ ...available, version: '1.2.0' }, '1.1.0')).toEqual({
            version: '1.2.0',
            message: 'Caxri 1.2.0 is available. You are running 1.0.0.',
        });
    });

    it('falls back to exact matching for a hand-edited skip it cannot parse', () => {
        expect(resolveUpdateAnnouncement(available, 'not-a-version')).toEqual({
            version: '1.1.0',
            message: 'Caxri 1.1.0 is available. You are running 1.0.0.',
        });
        expect(
            resolveUpdateAnnouncement({ ...available, version: 'nightly' }, 'nightly'),
        ).toBeUndefined();
    });

    it('never announces a status other than available', () => {
        expect(
            resolveUpdateAnnouncement({ status: 'up-to-date', currentVersion: '1.0.0' }, null),
        ).toBeUndefined();
        expect(
            resolveUpdateAnnouncement(
                {
                    status: 'downloading',
                    currentVersion: '1.0.0',
                    version: '1.1.0',
                    fileName: 'Caxri-1.1.0-arm64.dmg',
                    receivedBytes: 1,
                },
                null,
            ),
        ).toBeUndefined();
        expect(resolveUpdateAnnouncement(undefined, null)).toBeUndefined();
    });
});

describe('describeUpdateChip', () => {
    it('names the available release and drops it once skipped', () => {
        expect(describeUpdateChip(available, null)?.label).toBe('Update 1.1.0');
        expect(describeUpdateChip(available, '1.1.0')).toBeUndefined();
    });

    it('keeps an announced release on the chip, because Close is not a skip', () => {
        expect(describeUpdateChip({ ...available, announced: true }, null)?.kind).toBe('available');
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
            )?.kind,
        ).toBe('downloading');
        expect(
            describeUpdateChip(
                {
                    status: 'ready',
                    currentVersion: '1.0.0',
                    version: '1.1.0',
                    fileName: 'Caxri-1.1.0-arm64.dmg',
                },
                '1.1.0',
            ),
        ).toEqual({
            label: 'Update ready',
            description: 'Caxri 1.1.0 is downloaded and verified. Click to continue.',
            kind: 'ready',
        });
    });

    it('shows nothing for the transient and healthy statuses', () => {
        expect(describeUpdateChip(undefined, null)).toBeUndefined();
        expect(
            describeUpdateChip({ status: 'idle', currentVersion: '1.0.0' }, null),
        ).toBeUndefined();
        expect(
            describeUpdateChip({ status: 'checking', currentVersion: '1.0.0' }, null),
        ).toBeUndefined();
        expect(
            describeUpdateChip({ status: 'up-to-date', currentVersion: '1.0.0' }, null),
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
            ),
        ).toBeUndefined();
    });
});

describe('updateRetryTimeLabel', () => {
    const noon = Date.UTC(2026, 0, 2, 12, 0, 0);

    it('names the clock time a paused check resumes at', () => {
        expect(updateRetryTimeLabel(noon + 600_000, noon)).toMatch(/^\d{1,2}:\d{2}/u);
    });

    it('returns nothing for a deadline that already passed or was never reported', () => {
        expect(updateRetryTimeLabel(noon - 1, noon)).toBeUndefined();
        expect(updateRetryTimeLabel(undefined, noon)).toBeUndefined();
        expect(updateRetryTimeLabel(NaN, noon)).toBeUndefined();
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
        const copy = describeUpdateStatus(rateLimited, { now });
        expect(copy.title).toBe('Update checks are paused');
        expect(copy.description).toContain('Automatic checks resume after');
        expect(copy.description).toContain('without waiting');
    });

    it('still explains the pause when GitHub reported no deadline', () => {
        const copy = describeUpdateStatus({ ...rateLimited, retryAt: undefined }, { now });
        expect(copy.description).toContain('resume once the limit clears');
        expect(copy.description).toContain('without waiting');
    });

    it('does not promise a resume time that already passed', () => {
        const copy = describeUpdateStatus(rateLimited, { now: rateLimited.retryAt });
        expect(copy.description).toContain('resume once the limit clears');
    });

    it('leaves a non-rate-limited unavailable state on its own reason', () => {
        expect(
            describeUpdateStatus({
                status: 'unavailable',
                currentVersion: '1.0.0',
                reason: 'Update checks are available in packaged Caxri builds.',
            }),
        ).toEqual({
            title: 'Update checks unavailable',
            description: 'Update checks are available in packaged Caxri builds.',
        });
    });

    it('explains why a skipped release is not being offered', () => {
        expect(describeUpdateStatus(available, { skippedVersion: '1.1.0' }).description).toContain(
            'You skipped this version',
        );
        expect(describeUpdateStatus(available, { skippedVersion: null }).description).toContain(
            'Download Caxri-1.1.0-arm64.dmg',
        );
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
    it('explains the manual install exactly while a release is in play', () => {
        expect(shouldExplainUnsignedInstall(available)).toBe(true);
        expect(
            shouldExplainUnsignedInstall({
                status: 'downloading',
                currentVersion: '1.0.0',
                version: '1.1.0',
                fileName: 'Caxri-1.1.0-arm64.dmg',
                receivedBytes: 1,
                totalBytes: 2,
            }),
        ).toBe(true);
        // A failed download may still have left the file on disk, so the instructions stay useful.
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
        const copy = describeUpdateStatus(state);
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
    expect(describeUpdateStatus({ ...base, failureKind: 'network' }).description).toContain(
        'Check your network',
    );
    expect(describeUpdateStatus({ ...base, failureKind: 'integrity' }).description).toContain(
        'was not opened',
    );
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

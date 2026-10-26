export const updates = {
    // Update dialog
    'updates.dialog.title': 'Software Update',
    'updates.dialog.description': 'Caxri downloads updates from its official GitHub Release.',
    'updates.dialog.downloadProgress': 'Update download progress',
    'updates.dialog.unsignedNotice':
        "Caxri isn't signed by Apple yet, so macOS asks you to confirm. Quit Caxri before replacing it in Applications, then reopen it afterwards. Downloading does not interrupt running Terminals, but quitting stops them.",
    'updates.dialog.skipVersion': 'Skip This Version',
    'updates.action.checking': 'Checking…',
    'updates.action.stopSkipping': 'Stop Skipping',
    'updates.action.download': 'Download Update',
    'updates.action.cancelDownload': 'Cancel Download',
    'updates.action.openDmg': 'Open DMG',
    'updates.action.retryDownload': 'Retry Download',
    'updates.action.checkAgain': 'Check Again',
    'updates.action.releaseNotes': 'View Release Notes',
    'updates.toast.releaseNotes': 'Release Notes',

    // Commands and notifications
    'updates.error.check': 'Unable to check for updates',
    'updates.error.download': 'Unable to download the update',
    'updates.error.cancel': 'Unable to cancel the update download',
    'updates.error.open': 'Unable to open the update',
    'updates.error.skip': 'Unable to skip this version',
    'updates.error.stopSkipping': 'Unable to stop skipping this version',
    'updates.skipped':
        'Caxri will not offer {{version}} again until a newer version is released. Settings can undo this.',
    'updates.announcement.message':
        'Caxri {{version}} is available. You are running {{currentVersion}}.',
    'updates.updated.message': 'Updated to Caxri {{version}}',
    'updates.updated.releaseNotesLabel': 'Release Notes for Caxri {{version}}',
    'updates.announcement.showLabel': 'Show Update for Caxri {{version}}',

    // Dialog status copy
    'updates.status.loading.title': 'Loading update status…',
    'updates.status.loading.description': 'Please wait.',
    'updates.status.version': 'Caxri {{version}}',
    'updates.status.idle.description': 'Check GitHub Releases for a newer stable version.',
    'updates.status.checking.title': 'Checking for updates…',
    'updates.status.unavailable.title': 'Update checks unavailable',
    'updates.status.paused.title': 'Update checks are paused',
    'updates.status.paused.description':
        '{{reason}} {{resume}} Checking now asks GitHub anyway, without waiting.',
    'updates.status.paused.resumesAt': 'Automatic checks resume after {{time}}.',
    'updates.status.paused.resumesLater': 'Automatic checks resume once the limit clears.',
    'updates.status.upToDate.title': 'Caxri is up to date',
    'updates.status.upToDate.description': 'You are running the latest version, {{version}}.',
    'updates.status.available.title': 'Caxri {{version}} is available',
    'updates.status.available.skippedDescription':
        'You skipped this version, so Caxri stopped offering it. Stop skipping to download {{fileName}} and verify it here.',
    'updates.status.available.description':
        'Download {{fileName}} inside Caxri and verify it before opening.',
    'updates.status.downloading.title': 'Downloading Caxri {{version}}…',
    'updates.status.downloading.progress': '{{received}} of {{total}}',
    'updates.status.downloading.received': '{{received}} downloaded',
    'updates.status.ready.title': 'Caxri {{version}} is ready to install',
    'updates.status.ready.description': 'Downloaded and verified.',
    'updates.status.error.title': 'Update failed',
    'updates.status.error.network':
        'The update connection was interrupted. Check your network and try again.',
    'updates.status.error.integrity':
        'The download could not be verified and was not opened. Download it again.',
    'updates.status.error.open':
        'The downloaded installer could not be opened. Try again or open it from Finder.',
    'updates.status.error.generic': 'The update could not be completed. Please try again.',

    // Status bar chip
    'updates.chip.available.label': 'Update {{version}}',
    'updates.chip.available.description':
        'Caxri {{version}} is available. Click to show the update.',
    'updates.chip.downloading.label': 'Updating…',
    'updates.chip.downloading.labelPercent': 'Updating {{percent}}%',
    'updates.chip.downloading.description':
        'Downloading Caxri {{version}}. Click to show the download.',
    'updates.chip.ready.label': 'Update ready',
    'updates.chip.ready.description':
        'Caxri {{version}} is downloaded and verified. Click to continue.',
    'updates.chip.failed.label': 'Update failed',
    'updates.chip.failed.installDescription':
        'Caxri {{version}} could not be installed. Click to see why and try again.',
    'updates.chip.failed.downloadDescription':
        'Caxri {{version}} could not be downloaded. Click to see why and try again.',
} as const;

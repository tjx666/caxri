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
    'updates.action.restartToUpdate': 'Restart to Update',
    'updates.action.retryInstall': 'Try Again',
    'updates.action.retryDownload': 'Retry Download',
    'updates.action.checkAgain': 'Check Again',
    'updates.action.releaseNotes': 'View Release Notes',
    'updates.toast.releaseNotes': 'Release Notes',

    // Commands and notifications
    'updates.error.check': 'Unable to check for updates',
    'updates.error.download': 'Unable to download the update',
    'updates.error.cancel': 'Unable to cancel the update download',
    'updates.error.open': 'Unable to open the update',
    'updates.error.install': 'Unable to restart to update',
    'updates.error.skip': 'Unable to skip this version',
    'updates.error.stopSkipping': 'Unable to stop skipping this version',
    'updates.skipped':
        'Caxri will not offer {{version}} again until a newer version is released. Settings can undo this.',
    'updates.ready.message': 'Caxri {{version}} is ready. Restart to finish updating.',
    'updates.ready.resetsDataMessage':
        'Caxri {{version}} is ready. It clears your Projects and Sessions, so export them before restarting to update.',
    'updates.ready.manualMessage': 'Caxri {{version}} is downloaded and verified.',
    'updates.ready.restartLabel': 'Restart to install Caxri {{version}}',
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
    'updates.status.unavailable.feedUnavailable':
        'The Caxri release feed is not publicly available yet.',
    'updates.status.unavailable.unpackaged':
        'Update checks are available in packaged Caxri builds.',
    'updates.status.paused.title': 'Update checks are paused',
    'updates.status.paused.description':
        'Update checks are rate limited by GitHub right now. {{resume}} Checking now asks GitHub anyway, without waiting.',
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
    'updates.status.ready.restartDescription':
        'Downloaded and verified. Caxri restarts to finish installing; running Terminals and Agents are stopped. Quitting Caxri installs it too.',
    'updates.status.ready.resetsDataDescription':
        'Downloaded and verified. This update clears the Project and Session list; Project folders, files, and Agent conversations stay. Restart to Update offers an export first, and quitting Caxri does not install it.',
    'updates.status.error.install':
        'Caxri could not restart to install the update. Try again, or open the DMG and replace the app by hand.',
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
    'updates.chip.ready.restartLabel': 'Restart to update',
    'updates.chip.ready.description':
        'Caxri {{version}} is downloaded and verified. Click to continue.',
    'updates.chip.ready.restartDescription':
        'Caxri {{version}} is ready. Click to restart and finish updating.',
    'updates.chip.ready.resetsDataDescription':
        'Caxri {{version}} is ready and clears your Projects and Sessions. Click to export them and update.',
    'updates.chip.failed.label': 'Update failed',
    'updates.chip.failed.installDescription':
        'Caxri {{version}} could not be installed. Click to see why and try again.',
    'updates.chip.failed.downloadDescription':
        'Caxri {{version}} could not be downloaded. Click to see why and try again.',
} as const;

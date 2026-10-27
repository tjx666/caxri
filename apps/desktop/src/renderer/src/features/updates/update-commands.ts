import type { UpdateState } from '@caxri/protocol';

import { translate } from '../../i18n';
import { caxri } from '../../lib/caxri';
import { openExternalUrl } from '../../lib/external-link';
import { createStore } from '../../lib/store';
import { pushToast, tryCommand } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import {
    releaseNotesUrl,
    resolveAutomaticDownload,
    resolveReadyAnnouncement,
    resolveUpdatedNotice,
} from './update-presentation';

interface UpdateStoreState {
    open: boolean;
    state?: UpdateState;
    /**
     * True once this Renderer lifetime raised the "Updated to Caxri X" notice.
     */
    hasShownUpdatedNotice: boolean;
    setOpen(isOpen: boolean): void;
    setState(state: UpdateState): void;
    markUpdatedNoticeShown(): void;
}

export const useUpdateStore = createStore<UpdateStoreState>('update', (set) => ({
    open: false,
    state: undefined,
    hasShownUpdatedNotice: false,
    setOpen: (isOpen) => set({ open: isOpen }),
    setState: (state) => set({ state }),
    markUpdatedNoticeShown: () => set({ hasShownUpdatedNotice: true }),
}));

/**
 * Reads the persisted skip out of the Server snapshot. Not a hook: the announcement path runs from an event listener
 * rather than from a render. `undefined` means the snapshot has not arrived yet, which the caller must treat as
 * "unknown" rather than "nothing skipped".
 */
function skippedVersion(): string | null | undefined {
    return useWorkbenchStore.getState().bootstrap?.settings['updates.skippedVersion'];
}

async function recordAcknowledgement(): Promise<void> {
    try {
        await caxri.request('updates.acknowledge');
    } catch {
        // Failing to record it costs at most one repeated notification after a window reload, which is not worth a
        // failure toast of its own. The response is deliberately not written back into the store either: it would be
        // a stale `available` if the user has already started a download in the meantime.
    }
}

/**
 * Tells Main this process has already offered the available or ready version to the user, so a window reload (or a
 * download cancelled back to `available`) re-reads the same release without prompting again.
 */
function acknowledgeAvailableUpdate(): void {
    const status = useUpdateStore.getState().state?.status;
    if (status !== 'available' && status !== 'ready') return;
    void recordAcknowledgement();
}

/**
 * Opens the update dialog. Every route here is an explicit user act: the `Check for Updates` command, the status-bar
 * chip, or the notification's `Show Update`, which is the distinction this feature turns on: automatic discovery gets a
 * notification, never a modal that takes the screen and the Escape key away from whatever the user was doing.
 */
export function showUpdateDialog(): void {
    useUpdateStore.getState().setOpen(true);
    acknowledgeAvailableUpdate();
}

export function closeUpdateDialog(): void {
    useUpdateStore.getState().setOpen(false);
}

async function requestState(label: string, request: () => Promise<UpdateState>): Promise<void> {
    const state = await tryCommand(label, request);
    if (state) useUpdateStore.getState().setState(state);
}

async function runManualCheck(): Promise<void> {
    await requestState(translate('updates.error.check'), () => caxri.request('updates.check'));
    // The dialog is already showing the result, so this process has offered the release however the check started;
    // without this, closing the dialog and reloading the window would surface the same release a second time.
    acknowledgeAvailableUpdate();
}

export function checkForUpdates(): void {
    useUpdateStore.getState().setOpen(true);
    // Fire-and-forget: `requestState` reports failures through `tryCommand`'s own toast, so this
    // synchronous-looking wrapper never needs to await the outcome.
    void runManualCheck();
}

export function downloadUpdate(): void {
    void requestState(translate('updates.error.download'), () => caxri.request('updates.download'));
}

export function cancelUpdateDownload(): void {
    void requestState(translate('updates.error.cancel'), () => caxri.request('updates.cancel'));
}

export function openDownloadedUpdate(): void {
    void requestState(translate('updates.error.open'), () => caxri.request('updates.open'));
}

/**
 * `Restart to Update`. Main asks about running work first; a confirmed restart exits the app before this request
 * settles, so only a cancel (or a failure) ever comes back.
 */
export function installUpdate(): void {
    void requestState(translate('updates.error.install'), () => caxri.request('updates.install'));
}

/**
 * Persists `Skip this version`: the half of the two dismissals that outlives the process. Caxri stops offering the
 * release until a newer one appears, and the `Skipped update version` row in Settings is where it can be taken back.
 * The dialog closes only once the write succeeded, so a failed write never looks like a recorded decision.
 */
export async function skipUpdateVersion(version: string): Promise<void> {
    const result = await tryCommand(translate('updates.error.skip'), () =>
        caxri.request('settings.patch', {
            changes: [{ key: 'updates.skippedVersion', value: version }],
        }),
    );
    if (!result) return;
    closeUpdateDialog();
    pushToast('info', translate('updates.skipped', { version }));
}

export async function clearSkippedUpdateVersion(): Promise<void> {
    await tryCommand(translate('updates.error.stopSkipping'), () =>
        caxri.request('settings.patch', {
            changes: [{ key: 'updates.skippedVersion', value: null }],
        }),
    );
}

/**
 * Opens a release page in the user's browser; failures surface as a toast through the shared external-link path.
 */
export function openReleaseNotes({
    version,
    releaseUrl,
}: {
    version: string;
    releaseUrl?: string;
}): void {
    void openExternalUrl(releaseNotesUrl(version, releaseUrl), (message) => {
        pushToast('error', message, { history: false });
    });
}

/**
 * Raises the one-time "Updated to Caxri X" notice, then tells Main it was shown so a reload or a second window does not
 * repeat it. Held to once per Renderer lifetime as well, because state events arrive before the acknowledgement lands.
 */
function announceUpdatedVersion(state: UpdateState | undefined): void {
    const notice = resolveUpdatedNotice(state);
    const store = useUpdateStore.getState();
    if (!notice || store.hasShownUpdatedNotice) return;
    store.markUpdatedNoticeShown();
    pushToast('info', notice.message, {
        action: {
            id: 'updates.releaseNotes',
            params: { version: notice.version },
            accessibleLabel: translate('updates.updated.releaseNotesLabel', {
                version: notice.version,
            }),
        },
    });
    void recordAcknowledgement();
}

/**
 * Starts the background download of a release found on its own. Acknowledging first is what keeps a reload, or a
 * download the user cancels from the dialog, from starting it again in this process. While the dialog is open the user
 * is already deciding (Download, Skip, Close), so the release is only acknowledged.
 */
function downloadAvailableUpdate(state: UpdateState | undefined): void {
    if (!resolveAutomaticDownload(state, skippedVersion())) return;
    acknowledgeAvailableUpdate();
    if (!useUpdateStore.getState().open) downloadUpdate();
}

/**
 * Raises the one notification the update lifecycle allows itself: the verified release is ready. The dialog, when it is
 * open, already shows the same state and action, so the release is only acknowledged then.
 */
function announceReadyUpdate(state: UpdateState | undefined): void {
    const announcement = resolveReadyAnnouncement(state);
    if (!announcement) return;
    if (!useUpdateStore.getState().open)
        pushToast('info', announcement.message, {
            action:
                announcement.mode === 'restart'
                    ? {
                          id: 'updates.install',
                          accessibleLabel: translate('updates.ready.restartLabel', {
                              version: announcement.version,
                          }),
                      }
                    : {
                          id: 'updates.show',
                          accessibleLabel: translate('updates.announcement.showLabel', {
                              version: announcement.version,
                          }),
                      },
        });
    acknowledgeAvailableUpdate();
}

function announceUpdateState(state: UpdateState | undefined): void {
    announceUpdatedVersion(state);
    downloadAvailableUpdate(state);
    announceReadyUpdate(state);
}

/**
 * Keeps the update surfaces synchronized with Main-owned check and download state, downloads a release found on its own
 * in the background, and raises the one notification once it is ready to install.
 *
 * The announcement waits for the Server snapshot that carries `updates.skippedVersion`. Main answers `updates.getState`
 * from memory while the snapshot is still in flight, so announcing immediately would treat "the skip is not loaded yet"
 * as "nothing is skipped" and download exactly the release the user told Caxri to stop offering, most visibly right
 * after a window reload, which is when both reads race.
 */
export function subscribeUpdateState(): () => void {
    let isActive = true;
    let isAnnouncementDeferred = false;

    function applyState(state: UpdateState): void {
        useUpdateStore.getState().setState(state);
        if (useWorkbenchStore.getState().bootstrap === undefined) {
            isAnnouncementDeferred = true;
            return;
        }
        isAnnouncementDeferred = false;
        announceUpdateState(state);
    }

    async function loadState(): Promise<void> {
        try {
            const state = await caxri.request('updates.getState');
            if (isActive) applyState(state);
        } catch {
            // Best-effort initial sync; the `updates.state` event subscription below still keeps
            // the surfaces current even if this initial read fails.
        }
    }
    void loadState();

    const unsubscribeEvents = caxri.onEvent((event) => {
        if (event.event === 'updates.state') applyState(event.payload);
    });
    const unsubscribeWorkbench = useWorkbenchStore.subscribe((workbench) => {
        if (!isActive || !isAnnouncementDeferred || workbench.bootstrap === undefined) return;
        isAnnouncementDeferred = false;
        // Re-read rather than replaying the held state: a newer one may have landed while the snapshot was in flight.
        announceUpdateState(useUpdateStore.getState().state);
    });
    return () => {
        isActive = false;
        unsubscribeEvents();
        unsubscribeWorkbench();
    };
}

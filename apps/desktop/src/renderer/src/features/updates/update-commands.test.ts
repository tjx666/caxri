import type { UpdateState } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToastAction } from '../../stores/toast-actions';

const mocks = vi.hoisted(() => ({
    caxriOnEvent: vi.fn(),
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
    pushToast: vi.fn(
        (
            ...parameters: [kind: string, message: string, options?: { action?: ToastAction }]
        ): unknown => parameters,
    ),
    tryCommand: vi.fn(
        async (
            ...[, run]: [string, () => Promise<unknown>, { refresh?: () => Promise<void> }?]
        ): Promise<unknown> => run(),
    ),
}));

vi.mock('../../lib/caxri', () => ({
    caxri: { onEvent: mocks.caxriOnEvent, request: mocks.caxriRequest },
}));
vi.mock('../../stores/toasts', () => ({
    pushToast: mocks.pushToast,
    tryCommand: mocks.tryCommand,
}));

import { useWorkbenchStore } from '../../stores/workbench';
import {
    cancelUpdateDownload,
    checkForUpdates,
    clearSkippedUpdateVersion,
    downloadUpdate,
    openDownloadedUpdate,
    showUpdateDialog,
    skipUpdateVersion,
    subscribeUpdateState,
    useUpdateStore,
} from './update-commands';

const availableState: UpdateState = {
    status: 'available',
    currentVersion: '1.0.0',
    version: '1.1.0',
    fileName: 'caxri-1.1.0.dmg',
};
const announcedState: UpdateState = { ...availableState, announced: true };
const idleState: UpdateState = { status: 'idle', currentVersion: '1.0.0' };

type UpdateEventListener = (event: { event: string; payload: UpdateState }) => void;

/**
 * The announcement path waits for the Server snapshot that carries `updates.skippedVersion`, so every test that expects
 * a notification has to have one in place first.
 */
function setSkippedVersion(skippedVersion: string | null): void {
    useWorkbenchStore.setState({
        bootstrap: { settings: { 'updates.skippedVersion': skippedVersion } },
    } as never);
}

function resetStore(): void {
    useUpdateStore.setState({ open: false, state: undefined });
    useWorkbenchStore.setState({ bootstrap: undefined } as never);
}

function captureEventListener(): () => UpdateEventListener | undefined {
    let eventListener: UpdateEventListener | undefined;
    mocks.caxriOnEvent.mockImplementationOnce((listener: UpdateEventListener) => {
        eventListener = listener;
        return vi.fn();
    });
    return () => eventListener;
}

beforeEach(() => {
    resetStore();
    mocks.caxriOnEvent.mockReset();
    mocks.caxriOnEvent.mockReturnValue(vi.fn());
    mocks.caxriRequest.mockReset();
    mocks.caxriRequest.mockResolvedValue(undefined);
    mocks.pushToast.mockReset();
    mocks.tryCommand.mockClear();
});

describe('checkForUpdates / downloadUpdate / cancelUpdateDownload / openDownloadedUpdate', () => {
    it('opens the dialog synchronously and routes the check through tryCommand + caxri.request', async () => {
        mocks.caxriRequest.mockResolvedValueOnce(idleState);

        checkForUpdates();

        expect(useUpdateStore.getState().open).toBe(true);
        expect(mocks.tryCommand).toHaveBeenCalledWith(
            'Unable to check for updates',
            expect.any(Function),
        );
        await mocks.tryCommand.mock.results[0]?.value;
        expect(mocks.caxriRequest).toHaveBeenCalledWith('updates.check');
        expect(useUpdateStore.getState().state).toEqual(idleState);
    });

    it('wires downloadUpdate to updates.download with its own label', async () => {
        mocks.caxriRequest.mockResolvedValueOnce(availableState);

        downloadUpdate();

        expect(mocks.tryCommand).toHaveBeenCalledWith(
            'Unable to download the update',
            expect.any(Function),
        );
        await mocks.tryCommand.mock.results[0]?.value;
        expect(mocks.caxriRequest).toHaveBeenCalledWith('updates.download');
    });

    it('wires cancelUpdateDownload to updates.cancel with its own label', async () => {
        cancelUpdateDownload();

        expect(mocks.tryCommand).toHaveBeenCalledWith(
            'Unable to cancel the update download',
            expect.any(Function),
        );
        await mocks.tryCommand.mock.results[0]?.value;
        expect(mocks.caxriRequest).toHaveBeenCalledWith('updates.cancel');
    });

    it('wires openDownloadedUpdate to updates.open with its own label', async () => {
        cancelUpdateDownload(); // exercise a second call first to prove call indices are not conflated
        openDownloadedUpdate();

        expect(mocks.tryCommand).toHaveBeenLastCalledWith(
            'Unable to open the update',
            expect.any(Function),
        );
        await mocks.tryCommand.mock.results.at(-1)?.value;
        expect(mocks.caxriRequest).toHaveBeenLastCalledWith('updates.open');
    });

    it('does not force the dialog open when a background download resolves to available', async () => {
        resetStore(); // open: false
        mocks.caxriRequest.mockResolvedValueOnce(availableState);

        downloadUpdate();
        await mocks.tryCommand.mock.results[0]?.value;

        expect(useUpdateStore.getState().state).toEqual(availableState);
        expect(useUpdateStore.getState().open).toBe(false);
    });

    it('acknowledges the release an explicit check surfaced, so a reload does not prompt again', async () => {
        mocks.caxriRequest.mockResolvedValueOnce(availableState);

        checkForUpdates();
        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('updates.acknowledge'),
        );
        // The dialog carries the release; no notification competes with it.
        expect(mocks.pushToast).not.toHaveBeenCalled();
    });
});

describe('automatic discovery', () => {
    it('raises a Show Update notification instead of opening the modal dialog', async () => {
        setSkippedVersion(null);
        mocks.caxriRequest.mockResolvedValueOnce(availableState);

        const unsubscribe = subscribeUpdateState();
        await vi.waitFor(() => expect(useUpdateStore.getState().state).toEqual(availableState));

        expect(useUpdateStore.getState().open).toBe(false);
        const [kind, message, options] = mocks.pushToast.mock.calls[0] ?? [];
        expect(kind).toBe('info');
        expect(message).toBe('Caxri 1.1.0 is available. You are running 1.0.0.');
        // Recorded as a name plus the version it announces, so the notification center can still offer this route
        // after the toast expired, and a screen reader hears which release three `Show Update` buttons each mean.
        expect(options?.action).toEqual({
            id: 'updates.show',
            accessibleLabel: 'Show Update for Caxri 1.1.0',
        });
        unsubscribe();
    });

    it('leaves the dialog closed until that follow-up is taken', async () => {
        setSkippedVersion(null);
        mocks.caxriRequest.mockResolvedValueOnce(availableState);

        const unsubscribe = subscribeUpdateState();
        await vi.waitFor(() => expect(mocks.pushToast).toHaveBeenCalled());

        expect(useUpdateStore.getState().open).toBe(false);
        // What `updates.show` runs; the handler table pairs the id above with exactly this entry point.
        showUpdateDialog();
        expect(useUpdateStore.getState().open).toBe(true);
        unsubscribe();
    });

    it('stays silent for a release this process already announced', async () => {
        setSkippedVersion(null);
        mocks.caxriRequest.mockResolvedValueOnce(announcedState);

        const unsubscribe = subscribeUpdateState();
        await vi.waitFor(() => expect(useUpdateStore.getState().state).toEqual(announcedState));

        expect(mocks.pushToast).not.toHaveBeenCalled();
        expect(useUpdateStore.getState().open).toBe(false);
        unsubscribe();
    });

    it('stays silent for a skipped version', async () => {
        setSkippedVersion('1.1.0');
        mocks.caxriRequest.mockResolvedValueOnce(availableState);

        const unsubscribe = subscribeUpdateState();
        await vi.waitFor(() => expect(useUpdateStore.getState().state).toEqual(availableState));

        expect(mocks.pushToast).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('holds the announcement until the snapshot that carries the skip has arrived', async () => {
        // No bootstrap yet: `updates.getState` is answered from Main's memory while the Server snapshot is in flight.
        mocks.caxriRequest.mockResolvedValueOnce(availableState);

        const unsubscribe = subscribeUpdateState();
        await vi.waitFor(() => expect(useUpdateStore.getState().state).toEqual(availableState));
        expect(mocks.pushToast).not.toHaveBeenCalled();

        setSkippedVersion('1.1.0');
        expect(mocks.pushToast).not.toHaveBeenCalled();
        unsubscribe();
    });

    it('announces once the snapshot arrives and nothing is skipped', async () => {
        mocks.caxriRequest.mockResolvedValueOnce(availableState);

        const unsubscribe = subscribeUpdateState();
        await vi.waitFor(() => expect(useUpdateStore.getState().state).toEqual(availableState));
        expect(mocks.pushToast).not.toHaveBeenCalled();

        setSkippedVersion(null);
        expect(mocks.pushToast).toHaveBeenCalledOnce();
        unsubscribe();
    });

    it('does not re-prompt when a cancelled download republishes the same available release', async () => {
        setSkippedVersion(null);
        mocks.caxriRequest.mockResolvedValueOnce(idleState);
        const listener = captureEventListener();

        const unsubscribe = subscribeUpdateState();
        await vi.waitFor(() => expect(useUpdateStore.getState().state).toEqual(idleState));

        listener()?.({ event: 'updates.state', payload: availableState });
        expect(mocks.pushToast).toHaveBeenCalledOnce();

        // Main stamps `announced` onto the state it republishes after an abort.
        listener()?.({
            event: 'updates.state',
            payload: {
                status: 'downloading',
                currentVersion: '1.0.0',
                version: '1.1.0',
                fileName: 'caxri-1.1.0.dmg',
                receivedBytes: 10,
            },
        });
        listener()?.({ event: 'updates.state', payload: announcedState });

        expect(mocks.pushToast).toHaveBeenCalledOnce();
        expect(useUpdateStore.getState().open).toBe(false);
        unsubscribe();
    });

    it('ignores events for other channels and stops applying state after unsubscribe', async () => {
        setSkippedVersion(null);
        mocks.caxriRequest.mockResolvedValueOnce(idleState);
        type OtherEventListener = (event: { event: string; payload: unknown }) => void;
        let eventListener: OtherEventListener | undefined;
        const unsubscribeSpy = vi.fn();
        mocks.caxriOnEvent.mockImplementationOnce((listener: OtherEventListener) => {
            eventListener = listener;
            return unsubscribeSpy;
        });

        const unsubscribe = subscribeUpdateState();
        await vi.waitFor(() => expect(useUpdateStore.getState().state).toEqual(idleState));

        eventListener?.({ event: 'some.other.event', payload: availableState });
        expect(useUpdateStore.getState().state).toEqual(idleState);

        unsubscribe();
        expect(unsubscribeSpy).toHaveBeenCalledTimes(1);
    });
});

describe('showUpdateDialog', () => {
    it('acknowledges the release it reveals so a window reload stays silent', async () => {
        useUpdateStore.setState({ state: availableState });

        showUpdateDialog();

        expect(useUpdateStore.getState().open).toBe(true);
        await vi.waitFor(() =>
            expect(mocks.caxriRequest).toHaveBeenCalledWith('updates.acknowledge'),
        );
    });

    it('does not acknowledge a status that is not an available release', () => {
        useUpdateStore.setState({ state: idleState });

        showUpdateDialog();

        expect(mocks.caxriRequest).not.toHaveBeenCalledWith('updates.acknowledge');
    });
});

describe('skipUpdateVersion / clearSkippedUpdateVersion', () => {
    it('persists the skipped version and closes the dialog only after the write succeeds', async () => {
        useUpdateStore.setState({ open: true, state: availableState });
        mocks.caxriRequest.mockResolvedValueOnce({ changedKeys: ['updates.skippedVersion'] });

        await skipUpdateVersion('1.1.0');

        expect(mocks.caxriRequest).toHaveBeenCalledWith('settings.patch', {
            changes: [{ key: 'updates.skippedVersion', value: '1.1.0' }],
        });
        expect(useUpdateStore.getState().open).toBe(false);
    });

    it('keeps the dialog open when the skip could not be written', async () => {
        useUpdateStore.setState({ open: true, state: availableState });
        mocks.tryCommand.mockResolvedValueOnce(undefined);

        await skipUpdateVersion('1.1.0');

        expect(useUpdateStore.getState().open).toBe(true);
    });

    it('clears the skip by writing null', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({ changedKeys: ['updates.skippedVersion'] });

        await clearSkippedUpdateVersion();

        expect(mocks.caxriRequest).toHaveBeenCalledWith('settings.patch', {
            changes: [{ key: 'updates.skippedVersion', value: null }],
        });
    });
});

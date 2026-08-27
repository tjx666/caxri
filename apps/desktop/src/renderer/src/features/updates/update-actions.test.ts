import type { UpdateState } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriOnEvent: vi.fn(),
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve(undefined)),
    tryCommand: vi.fn(
        async (
            ...[, run]: [string, () => Promise<unknown>, { refresh?: () => Promise<void> }?]
        ): Promise<unknown> => run(),
    ),
}));

vi.mock('../../lib/caxri', () => ({
    caxri: { onEvent: mocks.caxriOnEvent, request: mocks.caxriRequest },
}));
vi.mock('../../stores/toasts', () => ({ tryCommand: mocks.tryCommand }));

import {
    cancelUpdateDownload,
    checkForUpdates,
    downloadUpdate,
    openDownloadedUpdate,
    subscribeUpdateState,
    useUpdateStore,
} from './update-actions';

const availableState: UpdateState = {
    status: 'available',
    currentVersion: '1.0.0',
    version: '1.1.0',
    fileName: 'caxri-1.1.0.dmg',
};
const idleState: UpdateState = { status: 'idle', currentVersion: '1.0.0' };

function resetStore(): void {
    useUpdateStore.setState({ open: false, state: undefined });
}

beforeEach(() => {
    resetStore();
    mocks.caxriOnEvent.mockReset();
    mocks.caxriOnEvent.mockReturnValue(vi.fn());
    mocks.caxriRequest.mockReset();
    mocks.caxriRequest.mockResolvedValue(undefined);
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

    it('does not force the dialog open when a background download resolves to available (shouldRevealAvailable=false)', async () => {
        resetStore(); // open: false
        mocks.caxriRequest.mockResolvedValueOnce(availableState);

        downloadUpdate();
        await mocks.tryCommand.mock.results[0]?.value;

        expect(useUpdateStore.getState().state).toEqual(availableState);
        expect(useUpdateStore.getState().open).toBe(false);
    });
});

describe('subscribeUpdateState', () => {
    it('reveals the dialog when the initial getState load resolves to an available update', async () => {
        mocks.caxriRequest.mockResolvedValueOnce(availableState);

        const unsubscribe = subscribeUpdateState();
        await vi.waitFor(() => expect(useUpdateStore.getState().state).toEqual(availableState));

        expect(useUpdateStore.getState().open).toBe(true);
        unsubscribe();
    });

    it('does not reveal the dialog when the initial getState load resolves to a non-available status', async () => {
        mocks.caxriRequest.mockResolvedValueOnce(idleState);

        const unsubscribe = subscribeUpdateState();
        await vi.waitFor(() => expect(useUpdateStore.getState().state).toEqual(idleState));

        expect(useUpdateStore.getState().open).toBe(false);
        unsubscribe();
    });

    it('reveals the dialog when an updates.state event reports an available update', async () => {
        mocks.caxriRequest.mockResolvedValueOnce(idleState);
        type UpdateEventListener = (event: { event: string; payload: UpdateState }) => void;
        let eventListener: UpdateEventListener | undefined;
        mocks.caxriOnEvent.mockImplementationOnce((listener: UpdateEventListener) => {
            eventListener = listener;
            return vi.fn();
        });

        const unsubscribe = subscribeUpdateState();
        await vi.waitFor(() => expect(useUpdateStore.getState().state).toEqual(idleState));
        expect(useUpdateStore.getState().open).toBe(false);

        eventListener?.({ event: 'updates.state', payload: availableState });

        expect(useUpdateStore.getState().state).toEqual(availableState);
        expect(useUpdateStore.getState().open).toBe(true);
        unsubscribe();
    });

    it('ignores events for other channels and stops applying state after unsubscribe', async () => {
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

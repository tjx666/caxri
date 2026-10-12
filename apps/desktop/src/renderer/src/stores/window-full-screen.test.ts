import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn<(method: string) => Promise<unknown>>() }));

vi.mock('../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { syncWindowFullScreen } from './window-full-screen';
import { useWorkbenchStore } from './workbench';

afterEach(() => {
    mocks.request.mockReset();
    useWorkbenchStore.setState({ isFullScreen: false });
});

describe('syncWindowFullScreen', () => {
    it('adopts the fullscreen state a reloaded Renderer cannot replay from its events', async () => {
        mocks.request.mockResolvedValueOnce({ isFullScreen: true });

        await syncWindowFullScreen();

        expect(mocks.request).toHaveBeenCalledWith('window.fullScreen.get');
        expect(useWorkbenchStore.getState().isFullScreen).toBe(true);
    });

    it('keeps the last known state when the read fails', async () => {
        useWorkbenchStore.setState({ isFullScreen: true });
        mocks.request.mockRejectedValueOnce(new Error('Window is closing'));

        await syncWindowFullScreen();

        expect(useWorkbenchStore.getState().isFullScreen).toBe(true);
    });
});

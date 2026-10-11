import type { CaxriBridge } from '@caxri/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => ({
    exposed: new Map<string, unknown>(),
    invoke: vi.fn(),
}));

vi.mock('electron', () => ({
    contextBridge: {
        exposeInMainWorld: (key: string, value: unknown) => electronMock.exposed.set(key, value),
    },
    ipcRenderer: {
        invoke: electronMock.invoke,
        on: vi.fn(),
        removeListener: vi.fn(),
        send: vi.fn(),
    },
    webUtils: { getPathForFile: vi.fn() },
}));

afterEach(() => {
    vi.restoreAllMocks();
});

describe('preload event stream', () => {
    it('logs a failed event recovery by name and message instead of swallowing it', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        electronMock.invoke.mockRejectedValue(new TypeError('Server connection closed'));
        await import('../index');
        const bridge = electronMock.exposed.get('caxri') as CaxriBridge;
        expect(bridge).toBeDefined();

        const unsubscribe = bridge.onEvent(() => {});
        await vi.waitFor(() => expect(error).toHaveBeenCalled());
        unsubscribe();

        expect(error).toHaveBeenCalledWith(
            '[caxri] Server event stream failed: TypeError: Server connection closed',
        );
    });
});

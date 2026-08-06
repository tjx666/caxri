import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeEvent } from '@shared/ipc/events';

const mocks = vi.hoisted(() => {
    let listener: ((event: RuntimeEvent) => void) | undefined;
    return {
        emit: (event: RuntimeEvent) => listener?.(event),
        onEvent: vi.fn((next: (event: RuntimeEvent) => void) => {
            listener = next;
            return () => {
                listener = undefined;
            };
        }),
        request: vi.fn(() => Promise.resolve({ configurationErrors: [] })),
        reset: () => {
            listener = undefined;
        },
    };
});

vi.mock('../lib/caxri', () => ({
    caxri: { onEvent: mocks.onEvent, request: mocks.request },
}));

import { subscribeWorkbenchEvents } from './workbench';

afterEach(() => {
    mocks.request.mockClear();
    mocks.onEvent.mockClear();
    mocks.reset();
});

describe('workbench Runtime events', () => {
    it('refreshes once for the state change that follows a Terminal exit', async () => {
        const unsubscribe = subscribeWorkbenchEvents({ onCommand: vi.fn() });

        mocks.emit({
            event: 'terminal.exit',
            payload: { terminalId: 'terminal-1', exitCode: 0 },
        });
        await Promise.resolve();
        expect(mocks.request).not.toHaveBeenCalled();

        mocks.emit({ event: 'state.changed', payload: { reason: 'terminal.exit' } });
        await vi.waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(1));
        unsubscribe();
    });
});

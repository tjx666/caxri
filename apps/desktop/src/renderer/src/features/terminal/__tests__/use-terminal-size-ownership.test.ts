import { describe, expect, it, vi } from 'vitest';

import {
    didHandleTerminalSizeOwnershipEvent,
    visibleMobileSizeOwnership,
} from '../hooks/use-terminal-size-ownership';

describe('visibleMobileSizeOwnership', () => {
    const mobile = {
        terminalId: 'terminal-1',
        owner: 'mobile' as const,
        cols: 42,
        rows: 20,
        attachEpoch: 3,
    };

    it('shows the current mobile PTY grid only for its live attachment and process', () => {
        expect(visibleMobileSizeOwnership(mobile, 'terminal-1', 3, 'running')).toEqual({
            cols: 42,
            rows: 20,
        });
        expect(visibleMobileSizeOwnership(mobile, 'terminal-2', 3, 'running')).toBeUndefined();
        expect(visibleMobileSizeOwnership(mobile, 'terminal-1', 4, 'running')).toBeUndefined();
        expect(visibleMobileSizeOwnership(mobile, 'terminal-1', 3, 'interrupted')).toBeUndefined();
    });

    it('hides the banner when Desktop owns the grid', () => {
        expect(
            visibleMobileSizeOwnership({ ...mobile, owner: 'desktop' }, 'terminal-1', 3, 'running'),
        ).toBeUndefined();
    });
});

describe('didHandleTerminalSizeOwnershipEvent', () => {
    it('applies only the matching Terminal grid and clears ownership on exit', () => {
        const resizeController = {
            setSizeOwnership: vi.fn(),
            resetSizeOwnership: vi.fn(),
        };
        const callbacks = {
            onSizeOwnership: vi.fn(),
            onTerminalExit: vi.fn(),
        };
        const event = {
            event: 'terminal.sizeOwnership' as const,
            payload: { terminalId: 'terminal-1', owner: 'mobile' as const, cols: 42, rows: 20 },
        };

        expect(
            didHandleTerminalSizeOwnershipEvent(event, 'terminal-2', resizeController, callbacks),
        ).toBe(true);
        expect(resizeController.setSizeOwnership).not.toHaveBeenCalled();
        expect(
            didHandleTerminalSizeOwnershipEvent(event, 'terminal-1', resizeController, callbacks),
        ).toBe(true);
        expect(resizeController.setSizeOwnership).toHaveBeenCalledWith('mobile', {
            cols: 42,
            rows: 20,
        });
        expect(callbacks.onSizeOwnership).toHaveBeenCalledWith(event.payload);

        expect(
            didHandleTerminalSizeOwnershipEvent(
                { event: 'terminal.exit', payload: { terminalId: 'terminal-1', exitCode: 0 } },
                'terminal-1',
                resizeController,
                callbacks,
            ),
        ).toBe(true);
        expect(resizeController.resetSizeOwnership).toHaveBeenCalledOnce();
        expect(callbacks.onTerminalExit).toHaveBeenCalledOnce();
    });
});

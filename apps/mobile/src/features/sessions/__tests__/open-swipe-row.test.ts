import { describe, expect, it, vi } from 'vitest';

import { createOpenSwipeRow } from '../open-swipe-row';

const row = () => ({ close: vi.fn() });

describe('open swipe row', () => {
    it('closes the open row as soon as a drag starts on another row', () => {
        const tracker = createOpenSwipeRow();
        const first = row();
        const second = row();
        tracker.handleOpen(first);
        tracker.handleDragStart(second);
        expect(first.close).toHaveBeenCalledOnce();
        tracker.handleOpen(second);
        expect(first.close).toHaveBeenCalledOnce();
        expect(second.close).not.toHaveBeenCalled();
    });

    it('keeps the dragged row closed until its release commits to opening', () => {
        const tracker = createOpenSwipeRow();
        const first = row();
        const second = row();
        tracker.handleOpen(first);
        tracker.handleDragStart(second);
        expect(tracker.hasOpen()).toBe(false);
    });

    it('still closes the previous row for a row that opens without a drag', () => {
        const tracker = createOpenSwipeRow();
        const first = row();
        const second = row();
        tracker.handleOpen(first);
        tracker.handleOpen(second);
        expect(first.close).toHaveBeenCalledOnce();
        expect(tracker.hasOpen()).toBe(true);
        tracker.closeOpen();
        expect(second.close).toHaveBeenCalledOnce();
    });

    it('lets the tap after an open row only close it', () => {
        const tracker = createOpenSwipeRow();
        const first = row();
        tracker.handleOpen(first);
        expect(tracker.hasOpen()).toBe(true);
        tracker.closeOpen();
        expect(first.close).toHaveBeenCalledOnce();
        expect(tracker.hasOpen()).toBe(false);
    });

    it('ignores a late close from a row that is no longer open', () => {
        const tracker = createOpenSwipeRow();
        const first = row();
        const second = row();
        tracker.handleOpen(first);
        tracker.handleDragStart(second);
        tracker.handleOpen(second);
        tracker.handleClose(first);
        tracker.closeOpen();
        expect(second.close).toHaveBeenCalledOnce();
    });

    it('forgets an open row that closes or unmounts on its own', () => {
        const tracker = createOpenSwipeRow();
        const first = row();
        tracker.handleOpen(first);
        tracker.handleClose(first);
        expect(tracker.hasOpen()).toBe(false);
        tracker.closeOpen();
        expect(first.close).not.toHaveBeenCalled();
    });
});

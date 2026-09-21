import type { MouseEvent as ReactMouseEvent } from 'react';

import { describe, expect, it, vi } from 'vitest';

import type { ReplayableRow, RowContextMenuGesture } from '../file-tree-context-menu-mount';
import {
    claimRowContextMenuGesture,
    replayRowContextMenu,
    shouldRenderRowContextMenu,
} from '../file-tree-context-menu-mount';

function row(): ReplayableRow & { calls: string[]; dispatched: Event[] } {
    const calls: string[] = [];
    const dispatched: Event[] = [];
    return {
        calls,
        dispatched,
        dispatchEvent: (event) => {
            calls.push('dispatchEvent');
            dispatched.push(event);
            return true;
        },
        focus: () => {
            calls.push('focus');
        },
    };
}

function gestureEvent(currentTarget: Element) {
    return {
        clientX: 42,
        clientY: 84,
        currentTarget,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    } as unknown as ReactMouseEvent & {
        preventDefault: ReturnType<typeof vi.fn>;
        stopPropagation: ReturnType<typeof vi.fn>;
    };
}

function gesture(overrides: Partial<RowContextMenuGesture> = {}): RowContextMenuGesture {
    return { clientX: 120, clientY: 340, hadFocus: false, ...overrides };
}

describe('lazy file-tree row context menu', () => {
    it('leaves a row that was never right-clicked without a menu subtree', () => {
        expect(shouldRenderRowContextMenu(true, false)).toBe(false);
    });

    it('mounts the menu subtree once an editable row has been right-clicked', () => {
        expect(shouldRenderRowContextMenu(true, true)).toBe(true);
    });

    it('never mounts a menu on a row that cannot be edited', () => {
        expect(shouldRenderRowContextMenu(false, true)).toBe(false);
    });

    it('records the exact point of the gesture so the replayed menu opens where the user clicked', () => {
        const element = {} as Element;
        const event = gestureEvent(element);

        expect(claimRowContextMenuGesture(event, null)).toEqual({
            clientX: 42,
            clientY: 84,
            hadFocus: false,
        });
    });

    it('keeps the claimed gesture away from the tree background menu', () => {
        const element = {} as Element;
        const event = gestureEvent(element);

        claimRowContextMenuGesture(event, null);

        expect(event.preventDefault).toHaveBeenCalledOnce();
        expect(event.stopPropagation).toHaveBeenCalledOnce();
    });

    it('remembers that the row itself was focused, which is how the keyboard path arrives', () => {
        const element = {} as Element;

        expect(claimRowContextMenuGesture(gestureEvent(element), element).hadFocus).toBe(true);
    });

    it('replays the gesture on the row so the first right click opens the menu', () => {
        const target = row();
        const created = new Event('contextmenu');
        const createEvent = vi.fn(() => created);

        replayRowContextMenu(target, gesture(), createEvent);

        expect(createEvent).toHaveBeenCalledWith(gesture());
        expect(target.dispatched).toEqual([created]);
    });

    it('returns focus to the row before replaying a gesture that came from the focused row', () => {
        const target = row();

        replayRowContextMenu(target, gesture({ hadFocus: true }), () => new Event('contextmenu'));

        expect(target.calls).toEqual(['focus', 'dispatchEvent']);
    });

    it('leaves focus alone when the gesture came from the pointer', () => {
        const target = row();

        replayRowContextMenu(target, gesture(), () => new Event('contextmenu'));

        expect(target.calls).toEqual(['dispatchEvent']);
    });
});

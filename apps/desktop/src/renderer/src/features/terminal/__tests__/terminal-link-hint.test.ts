import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createTerminalLinkHintController,
    TERMINAL_LINK_HINT_DELAY_MS,
    terminalLinkHintPosition,
} from '../terminal-link-hint';

function createHintDom() {
    const documentListeners = new Map<string, Set<EventListener>>();
    const windowListeners = new Map<string, Set<EventListener>>();
    const style: Partial<CSSStyleDeclaration> = {};
    const classRemove = vi.fn();
    const classToggle = vi.fn();
    const setAttribute = vi.fn();
    const hintElement = {
        className: '',
        getBoundingClientRect: () => ({ height: 32, width: 180 }),
        remove: vi.fn(),
        setAttribute,
        style,
        textContent: '',
    } as unknown as HTMLDivElement;
    const addListener = (
        listeners: Map<string, Set<EventListener>>,
        type: string,
        listener: EventListenerOrEventListenerObject,
    ) => {
        if (typeof listener !== 'function') return;
        const callbacks = listeners.get(type) ?? new Set<EventListener>();
        callbacks.add(listener);
        listeners.set(type, callbacks);
    };
    const removeListener = (
        listeners: Map<string, Set<EventListener>>,
        type: string,
        listener: EventListenerOrEventListenerObject,
    ) => {
        if (typeof listener === 'function') listeners.get(type)?.delete(listener);
    };
    const ownerWindow = {
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
            addListener(windowListeners, type, listener),
        innerHeight: 600,
        innerWidth: 800,
        removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
            removeListener(windowListeners, type, listener),
    } as unknown as Window;
    const ownerDocument = {
        addEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
            addListener(documentListeners, type, listener),
        createElement: vi.fn(() => hintElement),
        defaultView: ownerWindow,
        removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) =>
            removeListener(documentListeners, type, listener),
    } as unknown as Document;
    const append = vi.fn();
    const screenElement = {
        getBoundingClientRect: () => ({ bottom: 344, height: 320, top: 24 }),
    } as unknown as HTMLElement;
    const host = {
        append,
        classList: { remove: classRemove, toggle: classToggle },
        ownerDocument,
    } as unknown as HTMLElement;
    const dispatch = (listeners: Map<string, Set<EventListener>>, type: string, event: Event) => {
        const matchingListeners = listeners.get(type) ?? [];
        for (const listener of matchingListeners) listener(event);
    };
    return {
        append,
        classRemove,
        classToggle,
        dispatchDocument: (type: string, event: Event) => dispatch(documentListeners, type, event),
        dispatchWindow: (type: string, event: Event) => dispatch(windowListeners, type, event),
        hintElement,
        host,
        terminal: { element: host, rows: 10, screenElement } as never,
        setAttribute,
    };
}

describe('terminalLinkHintPosition', () => {
    it('places the hint above and clear of the pointer when space is available', () => {
        expect(
            terminalLinkHintPosition(
                { bottom: 216, clientX: 100, top: 184 },
                { height: 32, width: 180 },
                { height: 600, width: 800 },
            ),
        ).toEqual({ left: 112, top: 140 });
    });

    it('flips below and to the left at the top-right viewport edge', () => {
        expect(
            terminalLinkHintPosition(
                { bottom: 36, clientX: 790, top: 4 },
                { height: 32, width: 180 },
                { height: 600, width: 800 },
            ),
        ).toEqual({ left: 598, top: 48 });
    });
});

describe('createTerminalLinkHintController', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('delays the hint and cancels a pending open when the link is left', () => {
        const { append, terminal } = createHintDom();
        const controller = createTerminalLinkHintController(terminal);

        controller.show({ clientX: 100, clientY: 200 } as MouseEvent, 'Open link');
        vi.advanceTimersByTime(TERMINAL_LINK_HINT_DELAY_MS - 1);
        expect(append).not.toHaveBeenCalled();

        controller.hide();
        vi.runAllTimers();
        expect(append).not.toHaveBeenCalled();
    });

    it('shows the measured hint after the delay without covering the pointer row', () => {
        const { append, hintElement, setAttribute, terminal } = createHintDom();
        const controller = createTerminalLinkHintController(terminal);

        controller.show({ clientX: 100, clientY: 200 } as MouseEvent, '⌘ click to open in browser');
        vi.advanceTimersByTime(TERMINAL_LINK_HINT_DELAY_MS);

        expect(append).toHaveBeenCalledWith(hintElement);
        expect(hintElement.textContent).toBe('⌘ click to open in browser');
        expect(hintElement.style).toMatchObject({
            left: '112px',
            top: '140px',
            visibility: 'visible',
        });
        expect(setAttribute).toHaveBeenCalledWith('role', 'tooltip');
    });

    it('tracks the macOS Cmd modifier only while its link remains hovered', async () => {
        const { classRemove, classToggle, dispatchDocument, dispatchWindow, terminal } =
            createHintDom();
        const onModifierChange = vi.fn();
        const controller = createTerminalLinkHintController(terminal);

        controller.show(
            { clientX: 100, clientY: 200, metaKey: false } as MouseEvent,
            'Open link',
            onModifierChange,
        );
        await Promise.resolve();
        expect(onModifierChange).toHaveBeenLastCalledWith(false);

        dispatchDocument('keydown', { metaKey: true } as KeyboardEvent);
        expect(onModifierChange).toHaveBeenLastCalledWith(true);
        expect(classToggle).toHaveBeenLastCalledWith('terminal-link-modifier-active', true);
        dispatchWindow('blur', {} as Event);
        expect(onModifierChange).toHaveBeenLastCalledWith(false);

        controller.hide();
        const callCount = onModifierChange.mock.calls.length;
        dispatchDocument('keydown', { metaKey: true } as KeyboardEvent);
        expect(onModifierChange).toHaveBeenCalledTimes(callCount);
        expect(classToggle).toHaveBeenLastCalledWith('terminal-link-modifier-active', false);

        controller.dispose();
        expect(classRemove).toHaveBeenCalledWith('terminal-link-modifier-active');
        const toggleCount = classToggle.mock.calls.length;
        dispatchDocument('keyup', { metaKey: false } as KeyboardEvent);
        expect(classToggle).toHaveBeenCalledTimes(toggleCount);
    });

    it('tracks Cmd cursor state for an OSC link without a mutable decoration', async () => {
        const { classToggle, dispatchDocument, terminal } = createHintDom();
        const controller = createTerminalLinkHintController(terminal);

        controller.show({ clientX: 100, clientY: 200, metaKey: false } as MouseEvent, 'Open link');
        await Promise.resolve();
        dispatchDocument('keydown', { metaKey: true } as KeyboardEvent);
        expect(classToggle).toHaveBeenLastCalledWith('terminal-link-modifier-active', true);

        controller.hide();
        expect(classToggle).toHaveBeenLastCalledWith('terminal-link-modifier-active', false);
    });
});

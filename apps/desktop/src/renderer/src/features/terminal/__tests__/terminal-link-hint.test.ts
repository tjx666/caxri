import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createTerminalLinkHintController,
    TERMINAL_LINK_HINT_DELAY_MS,
    terminalLinkHintPosition,
} from '../terminal-link-hint';
import { terminalLinkHintKey } from '../terminal-links';
import type { TerminalReferencePreviewCard } from '../terminal-reference-preview';

function createHintDom() {
    const documentListeners = new Map<string, Set<EventListener>>();
    const windowListeners = new Map<string, Set<EventListener>>();
    const scrollListeners = new Set<() => void>();
    const classRemove = vi.fn();
    const classToggle = vi.fn();
    const elementRemove = vi.fn();
    const setAttribute = vi.fn();
    const elements: HTMLDivElement[] = [];
    /**
     * A fresh node per call, because a preview card renders its lines as children of the popup: one shared stub would
     * make every line overwrite the one before it.
     */
    const createElement = vi.fn(() => {
        const element = {
            children: [] as HTMLDivElement[],
            className: '',
            classList: { toggle: vi.fn() },
            getBoundingClientRect: () => ({ height: 32, width: 180 }),
            remove: elementRemove,
            replaceChildren: (...children: HTMLDivElement[]) => {
                element.children = children;
                element.textContent = children.map((child) => child.textContent).join('\n');
            },
            setAttribute,
            style: {} as Partial<CSSStyleDeclaration>,
            textContent: '',
        };
        elements.push(element as unknown as HTMLDivElement);
        return element;
    });
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
        createElement,
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
        dispatchScroll: () => {
            for (const listener of scrollListeners) listener();
        },
        dispatchWindow: (type: string, event: Event) => dispatch(windowListeners, type, event),
        elementRemove,
        elements,
        host,
        terminal: {
            element: host,
            onScroll: (listener: () => void) => {
                scrollListeners.add(listener);
                return { dispose: () => scrollListeners.delete(listener) };
            },
            rows: 10,
            screenElement,
        } as never,
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
        const { append, elements, setAttribute, terminal } = createHintDom();
        const controller = createTerminalLinkHintController(terminal);

        controller.show({ clientX: 100, clientY: 200 } as MouseEvent, '⌘ click to open in browser');
        vi.advanceTimersByTime(TERMINAL_LINK_HINT_DELAY_MS);

        expect(append).toHaveBeenCalledWith(elements[0]);
        expect(elements[0].textContent).toBe('⌘ click to open in browser');
        expect(elements[0].style).toMatchObject({
            left: '112px',
            top: '140px',
            visibility: 'visible',
        });
        expect(setAttribute).toHaveBeenCalledWith('role', 'tooltip');
    });

    it('keeps a visible hint mounted when xterm immediately reprovides the same link', async () => {
        const { append, elementRemove, terminal } = createHintDom();
        const controller = createTerminalLinkHintController(terminal);
        const event = { clientX: 100, clientY: 200 } as MouseEvent;

        controller.show(event, 'Open link', undefined, 'file:src/example.ts');
        vi.advanceTimersByTime(TERMINAL_LINK_HINT_DELAY_MS);
        controller.leave();
        controller.show(event, 'Open link', undefined, 'file:src/example.ts');
        await Promise.resolve();

        expect(append).toHaveBeenCalledTimes(1);
        expect(elementRemove).not.toHaveBeenCalled();
    });

    it('replaces a pending hint when a Terminal line redraws a different link in place', async () => {
        const { append, elements, terminal } = createHintDom();
        const controller = createTerminalLinkHintController(terminal);
        const event = { clientX: 100, clientY: 200 } as MouseEvent;
        const scope = 'plain:1:0:8';
        const commitKey = terminalLinkHintKey(scope, { kind: 'commit', text: 'f36a02ac' });
        const fileKey = terminalLinkHintKey(scope, { kind: 'file', text: 'foo/a.ts' });

        expect(commitKey).not.toBe(fileKey);
        controller.show(event, '⌘ click to show commit in Git', undefined, commitKey);
        controller.leave();
        controller.show(event, '⌘ click to open in editor', undefined, fileKey);
        vi.advanceTimersByTime(TERMINAL_LINK_HINT_DELAY_MS);
        await Promise.resolve();

        expect(append).toHaveBeenCalledOnce();
        expect(elements[0].textContent).toBe('⌘ click to open in editor');
    });

    it('hides after a genuine leave and replaces a different link with the same hint text', async () => {
        const { append, elementRemove, terminal } = createHintDom();
        const controller = createTerminalLinkHintController(terminal);
        const event = { clientX: 100, clientY: 200 } as MouseEvent;

        controller.show(event, 'Open link', undefined, 'file:src/first.ts');
        vi.advanceTimersByTime(TERMINAL_LINK_HINT_DELAY_MS);
        controller.leave();
        await Promise.resolve();
        expect(elementRemove).toHaveBeenCalledOnce();

        controller.show(event, 'Open link', undefined, 'file:src/second.ts');
        vi.advanceTimersByTime(TERMINAL_LINK_HINT_DELAY_MS);
        expect(append).toHaveBeenCalledTimes(2);
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

    it('keeps a held Cmd when a redraw reprovides the link with an older mouse event', async () => {
        const { classToggle, dispatchDocument, terminal } = createHintDom();
        const onModifierChange = vi.fn();
        const controller = createTerminalLinkHintController(terminal);
        // xterm reprovides a link from `_lastMouseEvent`, so a still pointer replays the move that
        // happened before the key press: its `metaKey` is `false` while Cmd is actually held.
        const staleMove = {
            clientX: 100,
            clientY: 200,
            metaKey: false,
            timeStamp: 10,
        } as MouseEvent;
        const linkKey = 'file:src/example.ts';

        controller.show(staleMove, 'Open link', onModifierChange, linkKey);
        await Promise.resolve();
        dispatchDocument('keydown', { metaKey: true, timeStamp: 20 } as KeyboardEvent);
        expect(onModifierChange).toHaveBeenLastCalledWith(true);

        controller.leave();
        controller.show(staleMove, 'Open link', onModifierChange, linkKey);
        await Promise.resolve();

        expect(onModifierChange).toHaveBeenLastCalledWith(true);
        expect(classToggle).toHaveBeenLastCalledWith('terminal-link-modifier-active', true);
    });

    it('accepts a mouse event newer than the last keyboard observation', async () => {
        const { classToggle, dispatchDocument, terminal } = createHintDom();
        const controller = createTerminalLinkHintController(terminal);

        controller.show(
            { clientX: 100, clientY: 200, metaKey: true, timeStamp: 10 } as MouseEvent,
            'Open link',
            undefined,
            'file:src/example.ts',
        );
        await Promise.resolve();
        dispatchDocument('keyup', { metaKey: false, timeStamp: 20 } as KeyboardEvent);
        expect(classToggle).toHaveBeenLastCalledWith('terminal-link-modifier-active', false);

        controller.leave();
        controller.show(
            { clientX: 110, clientY: 200, metaKey: true, timeStamp: 30 } as MouseEvent,
            'Open link',
            undefined,
            'file:src/example.ts',
        );
        await Promise.resolve();

        expect(classToggle).toHaveBeenLastCalledWith('terminal-link-modifier-active', true);
    });

    it('renders the basic card first and swaps in the loaded one, keeping the affordance last', async () => {
        const { elements, terminal } = createHintDom();
        const controller = createTerminalLinkHintController(terminal);
        const loaded = Promise.withResolvers<TerminalReferencePreviewCard>();

        controller.show(
            { clientX: 100, clientY: 200 } as MouseEvent,
            '⌘ click to show commit in Git',
            undefined,
            'commit:f36a02ac',
            {
                card: { detail: 'Git commit', facts: [], title: 'f36a02ac' },
                load: () => loaded.promise,
            },
        );
        vi.advanceTimersByTime(TERMINAL_LINK_HINT_DELAY_MS);

        expect(elements[0].textContent).toBe('f36a02ac\nGit commit\n⌘ click to show commit in Git');

        loaded.resolve({
            detail: 'caxri · f36a02ac',
            facts: ['Ada', '2 days ago'],
            title: 'Serialize Session-state writes',
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(elements[0].textContent).toBe(
            'Serialize Session-state writes\ncaxri · f36a02ac\nAda · 2 days ago\n⌘ click to show commit in Git',
        );
    });

    it('dismisses the card and cancels its read on Escape and on a Terminal scroll', async () => {
        const { append, dispatchDocument, dispatchScroll, elementRemove, terminal } =
            createHintDom();
        const controller = createTerminalLinkHintController(terminal);
        const aborted: boolean[] = [];
        const preview = {
            card: { facts: [], title: 'lobehub/lobe-chat#1' },
            load: (signal: AbortSignal) =>
                new Promise<TerminalReferencePreviewCard | undefined>((resolve) => {
                    signal.addEventListener('abort', () => {
                        aborted.push(true);
                        resolve(undefined);
                    });
                }),
        };

        controller.show(
            { clientX: 100, clientY: 200 } as MouseEvent,
            '⌘ click to open on GitHub',
            undefined,
            'github:1',
            preview,
        );
        vi.advanceTimersByTime(TERMINAL_LINK_HINT_DELAY_MS);
        expect(append).toHaveBeenCalledOnce();
        dispatchDocument('keydown', { key: 'Escape' } as KeyboardEvent);
        await Promise.resolve();
        expect(elementRemove).toHaveBeenCalledOnce();
        expect(aborted).toEqual([true]);

        // xterm reprovides the link on every redraw. A stationary pointer must not undo the dismissal.
        controller.show(
            { clientX: 100, clientY: 200 } as MouseEvent,
            '⌘ click to open on GitHub',
            undefined,
            'github:1',
            preview,
        );
        vi.advanceTimersByTime(TERMINAL_LINK_HINT_DELAY_MS);
        expect(append).toHaveBeenCalledOnce();

        controller.leave();
        await Promise.resolve();
        controller.show(
            { clientX: 100, clientY: 200 } as MouseEvent,
            '⌘ click to open on GitHub',
            undefined,
            'github:1',
            preview,
        );
        vi.advanceTimersByTime(TERMINAL_LINK_HINT_DELAY_MS);
        expect(append).toHaveBeenCalledTimes(2);

        dispatchScroll();
        await Promise.resolve();
        expect(elementRemove).toHaveBeenCalledTimes(2);
        expect(aborted).toEqual([true, true]);
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

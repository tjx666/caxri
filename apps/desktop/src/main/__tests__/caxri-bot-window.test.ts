import { EventEmitter } from 'node:events';

import type { StructuredLogger } from '@caxri/system';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { caxriBotMenuOptions, CaxriBotWindowController } from '../caxri-bot-window';

const auxiliaryWindow = vi.hoisted(() => ({
    created: [] as FakeWindow[],
}));

vi.mock('electron', () => ({
    screen: { getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
}));

vi.mock('../auxiliary-window/auxiliary-window', () => ({
    createAuxiliaryWindow: () => {
        const window = new FakeWindow();
        auxiliaryWindow.created.push(window);
        return window;
    },
    isAuxiliaryWindowRevealed: (window: FakeWindow | undefined) =>
        window !== undefined && !window.isDestroyed(),
    trackAuxiliaryWindowBounds: () => {},
}));

// eslint-disable-next-line unicorn/prefer-event-target -- stands in for Electron's WebContents, an EventEmitter
class FakeWebContents extends EventEmitter {
    readonly send = vi.fn();

    getOSProcessId(): number {
        return 1;
    }
}

// eslint-disable-next-line unicorn/prefer-event-target -- stands in for Electron's BrowserWindow, an EventEmitter
class FakeWindow extends EventEmitter {
    private isClosed = false;
    readonly webContents = new FakeWebContents();

    isDestroyed(): boolean {
        return this.isClosed;
    }

    isFullScreen(): boolean {
        return false;
    }

    close(): void {
        this.isClosed = true;
        this.emit('closed');
    }

    /**
     * A full-page navigation, as a crash-recovery reload starts.
     */
    reload(): void {
        this.webContents.emit('did-start-navigation', {}, 'about:blank', false, true);
    }
}

const inboxRequested = ['caxri:event', { event: 'caxriBot.inboxRequested', payload: {} }];

function inboxDeliveries(window: FakeWindow): number {
    return window.webContents.send.mock.calls.filter(
        (call) => JSON.stringify(call) === JSON.stringify(inboxRequested),
    ).length;
}

function createController(
    logger: () => StructuredLogger | undefined = () => ({ write: vi.fn() }) as never,
) {
    const controller = new CaxriBotWindowController({
        currentDirectory: '/app/out/main',
        detachTerminal: () => Promise.resolve(),
        isPackaged: false,
        loadWindowState: () => Promise.resolve({ wasOpenAtQuit: false }),
        logger,
        saveWindowState: () => Promise.resolve(),
        sendEvent: () => {},
        stopBot: () => Promise.resolve(),
        windowMode: 'visible',
        zoomLevel: () => 0,
    });
    const companion = controller.companion();
    return { controller, eventsReady: () => companion.onEventsReady() };
}

function lastWindow(): FakeWindow {
    const window = auxiliaryWindow.created.at(-1);
    if (!window) throw new Error('No Caxri Bot window was created');
    return window;
}

describe('Bot Inbox request delivery', () => {
    beforeEach(() => {
        auxiliaryWindow.created.length = 0;
    });

    it('delivers immediately to an open window whose Renderer already subscribed', () => {
        const { controller, eventsReady } = createController();
        controller.open();
        eventsReady();
        const window = lastWindow();
        expect(inboxDeliveries(window)).toBe(0);

        controller.open('inbox');

        expect(auxiliaryWindow.created).toHaveLength(1);
        expect(inboxDeliveries(window)).toBe(1);
    });

    it('holds the request for a new window until its Renderer subscribes, then delivers once', () => {
        const { controller, eventsReady } = createController();

        controller.open('inbox');
        const window = lastWindow();
        expect(inboxDeliveries(window)).toBe(0);

        eventsReady();
        expect(inboxDeliveries(window)).toBe(1);

        eventsReady();
        expect(inboxDeliveries(window)).toBe(1);
    });

    it('lets a later plain open replace an undelivered Inbox request', () => {
        const { controller, eventsReady } = createController();

        controller.open('inbox');
        controller.open();
        eventsReady();

        expect(inboxDeliveries(lastWindow())).toBe(0);
    });

    it('never carries a request to the next window after closing before its Renderer subscribes', () => {
        const { controller, eventsReady } = createController();

        controller.open('inbox');
        lastWindow().close();
        controller.open();
        eventsReady();

        expect(auxiliaryWindow.created).toHaveLength(2);
        expect(inboxDeliveries(lastWindow())).toBe(0);
    });

    it('waits for a reloading Renderer to subscribe again before delivering', () => {
        const { controller, eventsReady } = createController();
        controller.open();
        eventsReady();
        const window = lastWindow();

        window.reload();
        controller.open('inbox');
        expect(inboxDeliveries(window)).toBe(0);

        eventsReady();
        expect(inboxDeliveries(window)).toBe(1);
    });

    it('never carries a request to a later window when no logger was available to open one', () => {
        const logger: { current?: StructuredLogger } = {};
        const { controller, eventsReady } = createController(() => logger.current);

        controller.open('inbox');
        expect(auxiliaryWindow.created).toHaveLength(0);

        logger.current = { write: vi.fn() } as never;
        controller.open();
        eventsReady();

        expect(inboxDeliveries(lastWindow())).toBe(0);
    });
});

describe('Caxri Bot Command Palette request', () => {
    beforeEach(() => {
        auxiliaryWindow.created.length = 0;
    });

    it('opens the palette in Caxri Bot window and leaves any other window to the usual routing', () => {
        const { controller, eventsReady } = createController();
        controller.open();
        eventsReady();
        const window = lastWindow();

        expect(controller.requestCommandPalette(new FakeWindow() as never)).toBe(false);
        expect(controller.requestCommandPalette(window as never)).toBe(true);

        expect(window.webContents.send).toHaveBeenCalledExactlyOnceWith('caxri:event', {
            event: 'caxriBot.commandPaletteRequested',
            payload: {},
        });
    });

    it('swallows the shortcut while its Renderer is still loading instead of raising the Workbench', () => {
        const { controller } = createController();
        controller.open();
        const window = lastWindow();

        expect(controller.requestCommandPalette(window as never)).toBe(true);
        expect(window.webContents.send).not.toHaveBeenCalled();
    });
});

describe('caxriBotMenuOptions', () => {
    beforeEach(() => {
        auxiliaryWindow.created.length = 0;
    });

    it('routes the menu to the controller once it exists', () => {
        const holder: { controller?: CaxriBotWindowController } = {};
        const options = caxriBotMenuOptions(() => holder.controller);
        const other = new FakeWindow();

        expect(options.openWindowCommandPalette?.(other as never)).toBe(false);

        holder.controller = createController().controller;
        options.openCaxriBot();
        const window = lastWindow();

        expect(options.openWindowCommandPalette?.(window as never)).toBe(true);
        expect(options.openWindowCommandPalette?.(other as never)).toBe(false);
    });
});

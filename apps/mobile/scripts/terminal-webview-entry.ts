import { Terminal } from '@xterm/xterm';

import { createTerminalFrameBatch } from '../src/features/terminal/frame-batch';
import { resetTerminalSnapshot } from '../src/features/terminal/snapshot-reset';

interface TerminalBridgeWindow extends Window {
    __CAXRI_TERMINAL_ID__: string;
    __CAXRI_TERMINAL_THEME__: NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme'];
    CaxriTerminal?: { receiveHex: (hex: string) => void };
    ReactNativeWebView?: { postMessage: (message: string) => void };
}

const bridgeWindow = globalThis as unknown as TerminalBridgeWindow;
const terminalId = bridgeWindow.__CAXRI_TERMINAL_ID__;
const viewport = document.querySelector<HTMLElement>('#viewport');
const stage = document.querySelector<HTMLElement>('#stage');
const frame = document.querySelector<HTMLElement>('#frame');
if (!viewport || !stage || !frame) throw new Error('Terminal document is incomplete');

const terminal = new Terminal({
    cols: 80,
    rows: 24,
    disableStdin: true,
    scrollback: 3_000,
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 1.2,
    theme: bridgeWindow.__CAXRI_TERMINAL_THEME__,
});
terminal.open(stage);

const post = (message: Record<string, unknown>): void => {
    bridgeWindow.ReactNativeWebView?.postMessage(
        JSON.stringify({ version: 1, terminalId, ...message }),
    );
};

const terminalViewport = stage.querySelector<HTMLElement>('.xterm-viewport');
const viewState = { isAtBottom: true, zoom: 1, pinchDistance: null as number | null };

const distance = (first: Touch, second: Touch): number =>
    Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);

const reportScroll = (): void => {
    if (!terminalViewport) return;
    const isNext =
        terminalViewport.scrollHeight - terminalViewport.scrollTop - terminalViewport.clientHeight <
        24;
    if (isNext === viewState.isAtBottom) return;
    viewState.isAtBottom = isNext;
    post({ type: 'scroll', atBottom: viewState.isAtBottom });
};

const layout = (): void => {
    const screen = stage.querySelector<HTMLElement>('.xterm-screen');
    if (!screen) return;
    /**
     * Layout size ignores the stage transform, so the cell size never depends on the scale applied by a previous pass.
     * The renderer may apply a resize later than `terminal.resize`, which is why the screen element is observed too.
     */
    const cellWidth = screen.offsetWidth / Math.max(terminal.cols, 1);
    const cellHeight = screen.offsetHeight / Math.max(terminal.rows, 1);
    if (!(cellWidth > 0 && cellHeight > 0)) return;
    const gridWidth = terminal.cols * cellWidth;
    const gridHeight = terminal.rows * cellHeight;
    const widthFit = viewport.clientWidth / gridWidth;
    const heightFit = viewport.clientHeight / gridHeight;
    /**
     * An observed Terminal keeps the computer's size, which is usually far wider and taller than a phone. Every row
     * must stay visible because the newest output lands at the bottom of the grid, so the default scale never exceeds
     * the height fit. Width only shrinks to a readable floor; wider grids pan horizontally instead, and pinching can
     * zoom out until the whole width fits.
     */
    const fitted = Math.min(1, heightFit, Math.max(0.6, widthFit));
    const smallest = Math.min(1, widthFit, heightFit);
    const scale = Math.min(2, Math.max(smallest, fitted * viewState.zoom));
    stage.style.width = `${gridWidth}px`;
    stage.style.height = `${gridHeight}px`;
    stage.style.transform = `scale(${scale})`;
    frame.style.width = `${gridWidth * scale}px`;
    frame.style.height = `${gridHeight * scale}px`;
    if (viewState.isAtBottom) viewport.scrollTop = viewport.scrollHeight;
    const availableColumns = Math.floor(viewport.clientWidth / cellWidth);
    const availableRows = Math.floor(viewport.clientHeight / cellHeight);
    post({
        type: 'size',
        cols: Math.max(2, Math.min(1_000, availableColumns)),
        rows: Math.max(1, Math.min(1_000, availableRows)),
    });
};

terminalViewport?.addEventListener('scroll', reportScroll, { passive: true });
const gesture = { startX: 0, startY: 0, lastX: 0, startedAt: 0, moved: false, panning: false };

viewport.addEventListener(
    'touchstart',
    (event) => {
        const first = event.touches.item(0);
        const second = event.touches.item(1);
        if (first && second && event.touches.length === 2)
            viewState.pinchDistance = distance(first, second);
        if (first && event.touches.length === 1) {
            gesture.startX = first.clientX;
            gesture.startY = first.clientY;
            gesture.lastX = first.clientX;
            gesture.startedAt = Date.now();
            gesture.moved = false;
            gesture.panning = false;
        } else gesture.moved = true;
    },
    { capture: true, passive: true },
);
/**
 * Xterm consumes vertical swipes for scrollback, which also swallows horizontal ones. This capture-phase handler owns
 * horizontal drags so a grid wider than the phone can still be panned.
 */
viewport.addEventListener(
    'touchmove',
    (event) => {
        const first = event.touches.item(0);
        if (!first || event.touches.length !== 1) return;
        const dx = first.clientX - gesture.startX;
        const dy = first.clientY - gesture.startY;
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) gesture.moved = true;
        if (!gesture.panning && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.5)
            gesture.panning = true;
        if (!gesture.panning) return;
        viewport.scrollLeft -= first.clientX - gesture.lastX;
        gesture.lastX = first.clientX;
        event.preventDefault();
        event.stopPropagation();
    },
    { capture: true, passive: false },
);
viewport.addEventListener(
    'touchmove',
    (event) => {
        const first = event.touches.item(0);
        const second = event.touches.item(1);
        if (!first || !second || !viewState.pinchDistance || event.touches.length !== 2) return;
        const nextDistance = distance(first, second);
        viewState.zoom = Math.max(
            0.2,
            Math.min(3, viewState.zoom * (nextDistance / viewState.pinchDistance)),
        );
        viewState.pinchDistance = nextDistance;
        event.preventDefault();
        layout();
    },
    { passive: false },
);
viewport.addEventListener(
    'touchend',
    (event) => {
        viewState.pinchDistance = null;
        if (event.touches.length === 0 && !gesture.moved && Date.now() - gesture.startedAt < 350)
            post({ type: 'tap' });
    },
    { capture: true, passive: true },
);
const layoutObserver = new ResizeObserver(layout);
layoutObserver.observe(viewport);
const screenElement = stage.querySelector<HTMLElement>('.xterm-screen');
if (screenElement) layoutObserver.observe(screenElement);

const batch = createTerminalFrameBatch({
    cancel: (id) => cancelAnimationFrame(id),
    schedule: (callback) => requestAnimationFrame(callback),
    write: (data) => {
        const scrollTop = terminalViewport?.scrollTop ?? 0;
        const shouldFollow = viewState.isAtBottom;
        terminal.write(data, () => {
            if (shouldFollow) {
                terminal.scrollToBottom();
                viewport.scrollTop = viewport.scrollHeight;
            } else if (terminalViewport) terminalViewport.scrollTop = scrollTop;
            reportScroll();
        });
    },
});

bridgeWindow.CaxriTerminal = {
    receiveHex: (hex) => {
        if (!/^(?:[0-9a-f]{2})+$/u.test(hex) || hex.length > 100_000) return;
        try {
            const bytes = new Uint8Array(hex.length / 2);
            for (let index = 0; index < bytes.length; index += 1)
                bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
            const raw: unknown = JSON.parse(
                new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            );
            if (!raw || typeof raw !== 'object') return;
            const command = raw as Record<string, unknown>;
            if (command.version !== 1 || command.terminalId !== terminalId) return;
            const hasGrid =
                Number.isSafeInteger(command.cols) &&
                Number.isSafeInteger(command.rows) &&
                Number(command.cols) >= 2 &&
                Number(command.cols) <= 1_000 &&
                Number(command.rows) >= 1 &&
                Number(command.rows) <= 1_000;
            if (hasGrid && command.type === 'reset') {
                batch.reset();
                resetTerminalSnapshot(terminal, Number(command.cols), Number(command.rows));
                viewState.isAtBottom = true;
                post({ type: 'scroll', atBottom: true });
                layout();
            } else if (hasGrid && command.type === 'resize') {
                terminal.resize(Number(command.cols), Number(command.rows));
                layout();
            } else if (
                command.type === 'append' &&
                typeof command.data === 'string' &&
                command.data.length <= 24 * 1_024
            )
                batch.push(command.data);
            else if (command.type === 'jump') {
                terminal.scrollToBottom();
                viewport.scrollTop = viewport.scrollHeight;
                reportScroll();
            }
        } catch {
            post({ type: 'error', code: 'render-failed' });
        }
    },
};

layout();
post({ type: 'ready' });

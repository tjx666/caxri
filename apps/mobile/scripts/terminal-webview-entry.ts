import { Terminal } from '@xterm/xterm';

import { createTerminalFrameBatch } from '../src/features/terminal/frame-batch';
import { resetTerminalSnapshot } from '../src/features/terminal/snapshot-reset';
import { isTerminalViewAtBottom, terminalViewScale } from '../src/features/terminal/view-scale';

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

const viewState = {
    isAtBottom: true,
    zoom: 1,
    scale: 1,
    pinchDistance: null as number | null,
};

const distance = (first: Touch, second: Touch): number =>
    Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);

/**
 * Xterm 6 scrolls through a virtual `ScrollableElement`, so `.xterm-viewport` no longer emits native scroll events; the
 * buffer position and the outer viewport must both be at the bottom to follow output.
 */
const reportScroll = (): void => {
    const isNext = isTerminalViewAtBottom(terminal.buffer.active, viewport);
    if (isNext === viewState.isAtBottom) return;
    viewState.isAtBottom = isNext;
    post({ type: 'scroll', atBottom: viewState.isAtBottom });
};
terminal.onScroll(reportScroll);
terminal.buffer.onBufferChange(reportScroll);

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
     * A tall Desktop grid scrolls vertically at the readable default; pinching can still fit the whole grid.
     */
    const scale = terminalViewScale({ heightFit, widthFit, zoom: viewState.zoom });
    viewState.scale = scale;
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

const gesture = {
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    lastAt: 0,
    startedAt: 0,
    moved: false,
    axis: null as 'x' | 'y' | null,
    /**
     * Sub-line drag distance carried between moves, in CSS pixels of the scaled grid.
     */
    pendingY: 0,
    velocityY: 0,
};
const momentum = { frame: 0 };

const stopMomentum = (): void => {
    if (momentum.frame) cancelAnimationFrame(momentum.frame);
    momentum.frame = 0;
};

const lineHeight = (): number => {
    const screen = stage.querySelector<HTMLElement>('.xterm-screen');
    const height = screen ? screen.offsetHeight / Math.max(terminal.rows, 1) : 0;
    return height > 0 ? height * viewState.scale : 16;
};

/**
 * Moves content by a vertical finger delta. A grid zoomed taller than the phone pans the page first; once the page is
 * at its edge, the rest of the delta scrolls xterm's scrollback line by line.
 *
 * @param delta Positive when the finger moves down, which reveals earlier output.
 */
const scrollBy = (delta: number): void => {
    const maxPageScroll = viewport.scrollHeight - viewport.clientHeight;
    let remaining = delta;
    if (maxPageScroll > 0) {
        const before = viewport.scrollTop;
        viewport.scrollTop = Math.min(maxPageScroll, Math.max(0, before - remaining));
        remaining -= before - viewport.scrollTop;
        reportScroll();
    }
    gesture.pendingY += remaining;
    const height = lineHeight();
    const lines = Math.trunc(gesture.pendingY / height);
    if (lines === 0) return;
    gesture.pendingY -= lines * height;
    terminal.scrollLines(-lines);
};

const glide = (): void => {
    stopMomentum();
    let last = performance.now();
    const step = (now: number): void => {
        const elapsed = now - last;
        last = now;
        gesture.velocityY *= 0.95 ** (elapsed / 16);
        if (Math.abs(gesture.velocityY) < 0.05) {
            momentum.frame = 0;
            return;
        }
        scrollBy(gesture.velocityY * elapsed);
        momentum.frame = requestAnimationFrame(step);
    };
    momentum.frame = requestAnimationFrame(step);
};
viewport.addEventListener('scroll', reportScroll, { passive: true });

viewport.addEventListener(
    'touchstart',
    (event) => {
        const first = event.touches.item(0);
        const second = event.touches.item(1);
        if (first && second && event.touches.length === 2)
            viewState.pinchDistance = distance(first, second);
        stopMomentum();
        if (first && event.touches.length === 1) {
            gesture.startX = first.clientX;
            gesture.startY = first.clientY;
            gesture.lastX = first.clientX;
            gesture.lastY = first.clientY;
            gesture.lastAt = event.timeStamp;
            gesture.startedAt = Date.now();
            gesture.moved = false;
            gesture.axis = null;
            gesture.pendingY = 0;
            gesture.velocityY = 0;
        } else gesture.moved = true;
    },
    { capture: true, passive: true },
);
/**
 * Xterm 6 registers no touch handling for its scrollable element, so neither axis scrolls on a phone by default. This
 * capture-phase handler locks each single-finger drag to its dominant axis: horizontal pans a grid wider than the
 * phone, vertical scrolls the scrollback.
 * https://github.com/xtermjs/xterm.js/blob/master/src/browser/scrollable/touch.ts
 */
viewport.addEventListener(
    'touchmove',
    (event) => {
        const first = event.touches.item(0);
        if (!first || event.touches.length !== 1) return;
        const dx = first.clientX - gesture.startX;
        const dy = first.clientY - gesture.startY;
        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) gesture.moved = true;
        if (!gesture.axis && gesture.moved)
            gesture.axis = Math.abs(dx) > Math.abs(dy) * 1.5 ? 'x' : 'y';
        if (!gesture.axis) return;
        if (gesture.axis === 'x') viewport.scrollLeft -= first.clientX - gesture.lastX;
        else {
            const delta = first.clientY - gesture.lastY;
            const elapsed = Math.max(1, event.timeStamp - gesture.lastAt);
            gesture.velocityY = 0.8 * (delta / elapsed) + 0.2 * gesture.velocityY;
            scrollBy(delta);
        }
        gesture.lastX = first.clientX;
        gesture.lastY = first.clientY;
        gesture.lastAt = event.timeStamp;
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
        /**
         * A finger resting before lift-off means the reader stopped on purpose, so only a recent move keeps gliding.
         */
        if (
            event.touches.length === 0 &&
            gesture.axis === 'y' &&
            event.timeStamp - gesture.lastAt < 80
        )
            glide();
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
        const outerScrollTop = viewport.scrollTop;
        const shouldFollow = viewState.isAtBottom;
        terminal.write(data, () => {
            /**
             * Xterm keeps a reader's scrolled-up position while output arrives, so only a following view needs moving.
             */
            if (shouldFollow) {
                terminal.scrollToBottom();
                viewport.scrollTop = viewport.scrollHeight;
            } else {
                viewport.scrollTop = outerScrollTop;
            }
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
                stopMomentum();
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

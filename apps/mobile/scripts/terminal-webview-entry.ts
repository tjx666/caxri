import { Terminal } from '@xterm/xterm';

import { createTerminalFrameBatch } from '../src/features/terminal/frame-batch';

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
    const bounds = screen.getBoundingClientRect();
    const currentScale = Number(stage.dataset.scale ?? '1');
    const cellWidth = bounds.width / Math.max(terminal.cols * currentScale, 1);
    const cellHeight = bounds.height / Math.max(terminal.rows * currentScale, 1);
    if (!(cellWidth > 0 && cellHeight > 0)) return;
    const gridWidth = terminal.cols * cellWidth;
    const gridHeight = terminal.rows * cellHeight;
    const widthScale = viewport.clientWidth / gridWidth;
    const scale = Math.min(1.8, Math.max(0.72, Math.min(1, widthScale) * viewState.zoom));
    stage.style.width = `${gridWidth}px`;
    stage.style.height = `${gridHeight}px`;
    stage.style.transform = `scale(${scale})`;
    stage.dataset.scale = String(scale);
    frame.style.width = `${gridWidth * scale}px`;
    frame.style.height = `${gridHeight * scale}px`;
    const availableColumns = Math.floor(viewport.clientWidth / cellWidth);
    const availableRows = Math.floor(viewport.clientHeight / cellHeight);
    post({
        type: 'size',
        cols: Math.max(2, Math.min(1_000, availableColumns)),
        rows: Math.max(1, Math.min(1_000, availableRows)),
    });
};

terminalViewport?.addEventListener('scroll', reportScroll, { passive: true });
viewport.addEventListener(
    'touchstart',
    (event) => {
        const first = event.touches.item(0);
        const second = event.touches.item(1);
        if (first && second && event.touches.length === 2)
            viewState.pinchDistance = distance(first, second);
    },
    { passive: true },
);
viewport.addEventListener(
    'touchmove',
    (event) => {
        const first = event.touches.item(0);
        const second = event.touches.item(1);
        if (!first || !second || !viewState.pinchDistance || event.touches.length !== 2) return;
        const nextDistance = distance(first, second);
        viewState.zoom = Math.max(
            0.7,
            Math.min(2, viewState.zoom * (nextDistance / viewState.pinchDistance)),
        );
        viewState.pinchDistance = nextDistance;
        event.preventDefault();
        layout();
    },
    { passive: false },
);
viewport.addEventListener(
    'touchend',
    () => {
        viewState.pinchDistance = null;
    },
    { passive: true },
);
new ResizeObserver(layout).observe(viewport);

const batch = createTerminalFrameBatch({
    cancel: (id) => cancelAnimationFrame(id),
    schedule: (callback) => requestAnimationFrame(callback),
    write: (data) => {
        const scrollTop = terminalViewport?.scrollTop ?? 0;
        const shouldFollow = viewState.isAtBottom;
        terminal.write(data, () => {
            if (shouldFollow) terminal.scrollToBottom();
            else if (terminalViewport) terminalViewport.scrollTop = scrollTop;
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
            if (
                command.type === 'reset' &&
                Number.isSafeInteger(command.cols) &&
                Number.isSafeInteger(command.rows) &&
                Number(command.cols) >= 2 &&
                Number(command.cols) <= 1_000 &&
                Number(command.rows) >= 1 &&
                Number(command.rows) <= 1_000
            ) {
                batch.reset();
                terminal.reset();
                terminal.resize(Number(command.cols), Number(command.rows));
                viewState.isAtBottom = true;
                post({ type: 'scroll', atBottom: true });
                layout();
            } else if (
                command.type === 'append' &&
                typeof command.data === 'string' &&
                command.data.length <= 24 * 1_024
            )
                batch.push(command.data);
            else if (command.type === 'jump') {
                terminal.scrollToBottom();
                reportScroll();
            }
        } catch {
            post({ type: 'error', code: 'render-failed' });
        }
    },
};

layout();
post({ type: 'ready' });

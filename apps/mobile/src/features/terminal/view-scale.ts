/**
 * Default display scale of a Desktop grid on the phone, which also sets the text size of the phone's own grid while it
 * holds the lease so taking over does not suddenly enlarge the Terminal.
 */
export const READABLE_TERMINAL_SCALE = 0.6;

export const terminalViewScale = ({
    heightFit,
    widthFit,
    zoom,
}: {
    heightFit: number;
    widthFit: number;
    zoom: number;
}): number => {
    const fitted = Math.max(READABLE_TERMINAL_SCALE, Math.min(1, widthFit, heightFit));
    const smallest = Math.min(1, widthFit, heightFit);
    return Math.min(2, Math.max(smallest, fitted * zoom));
};

/**
 * Scale of the phone's own grid while it holds the lease. Pinching changes this scale, and the grid is then resized to
 * fill the phone at the new text size.
 */
export const leasedTerminalScale = (zoom: number): number =>
    Math.min(2, Math.max(0.3, READABLE_TERMINAL_SCALE * zoom));

/**
 * The grid the phone requests when it takes over: as many cells as fit its viewport at the leased text size.
 */
export const terminalPhoneGrid = ({
    cellHeight,
    cellWidth,
    height,
    width,
    zoom,
}: {
    cellHeight: number;
    cellWidth: number;
    height: number;
    width: number;
    zoom: number;
}): { cols: number; rows: number } => {
    const scale = leasedTerminalScale(zoom);
    return {
        cols: Math.max(2, Math.min(1_000, Math.floor(width / (cellWidth * scale)))),
        rows: Math.max(1, Math.min(1_000, Math.floor(height / (cellHeight * scale)))),
    };
};

export const isTerminalViewAtBottom = (
    buffer: { baseY: number; viewportY: number },
    outer: { clientHeight: number; scrollHeight: number; scrollTop: number },
): boolean =>
    buffer.viewportY >= buffer.baseY &&
    outer.scrollHeight - outer.scrollTop - outer.clientHeight < 24;

/**
 * One wheel message per drag frame; a fling still covers a long history through consecutive frames.
 */
export const TERMINAL_WHEEL_MAX_LINES = 50;

/**
 * Alternate-screen and mouse-reporting applications own their scrolling, so the phone forwards the drag to the
 * application as wheel input instead of moving xterm's local scrollback, matching Desktop's wheel behavior. X10
 * tracking never reports the wheel, so a normal-screen X10 application keeps local scrolling.
 */
export const shouldForwardTerminalScroll = ({
    bufferType,
    mouseTrackingMode,
}: {
    bufferType: 'normal' | 'alternate';
    mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any';
}): boolean =>
    bufferType === 'alternate' || (mouseTrackingMode !== 'none' && mouseTrackingMode !== 'x10');

export const terminalViewScale = ({
    heightFit,
    widthFit,
    zoom,
}: {
    heightFit: number;
    widthFit: number;
    zoom: number;
}): number => {
    const fitted = Math.max(0.6, Math.min(1, widthFit, heightFit));
    const smallest = Math.min(1, widthFit, heightFit);
    return Math.min(2, Math.max(smallest, fitted * zoom));
};

export const isTerminalViewAtBottom = (
    buffer: { baseY: number; viewportY: number },
    outer: { clientHeight: number; scrollHeight: number; scrollTop: number },
): boolean =>
    buffer.viewportY >= buffer.baseY &&
    outer.scrollHeight - outer.scrollTop - outer.clientHeight < 24;

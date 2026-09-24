export interface SessionPreviewPosition {
    isAtBottom: boolean;
    offset: number;
}

export const isPreviewAtBottom = (
    offset: number,
    viewportHeight: number,
    contentHeight: number,
): boolean => offset + viewportHeight >= contentHeight - 24;

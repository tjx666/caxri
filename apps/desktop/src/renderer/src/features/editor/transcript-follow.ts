const TRANSCRIPT_BOTTOM_THRESHOLD_PX = 24;

export function isTranscriptAtLatest(
    viewport: { scrollHeight: number; scrollTop: number; viewportHeight: number },
    threshold = TRANSCRIPT_BOTTOM_THRESHOLD_PX,
): boolean {
    return viewport.scrollTop + viewport.viewportHeight >= viewport.scrollHeight - threshold;
}

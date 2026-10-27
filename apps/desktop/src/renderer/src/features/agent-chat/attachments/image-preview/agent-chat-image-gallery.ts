/**
 * Which way a step through a message's images goes.
 */
export type AgentChatImageStep = 'previous' | 'next';

/**
 * The image a step lands on. The gallery stops at either end instead of wrapping, so stepping past the first or last
 * image stays put.
 */
export function stepAgentChatImageIndex(
    index: number,
    count: number,
    step: AgentChatImageStep,
): number {
    const next = step === 'previous' ? index - 1 : index + 1;
    return Math.min(Math.max(next, 0), Math.max(count - 1, 0));
}

/**
 * The step a key press asks for in the preview. Left and Right switch images, except while the focused element can
 * scroll sideways: a zoomed-in picture keeps its arrow keys for panning, as the file preview's does.
 */
export function agentChatImageStepForKey(
    key: string,
    { canScrollSideways }: { canScrollSideways: boolean },
): AgentChatImageStep | undefined {
    if (canScrollSideways) return undefined;
    if (key === 'ArrowLeft') return 'previous';
    if (key === 'ArrowRight') return 'next';
    return undefined;
}

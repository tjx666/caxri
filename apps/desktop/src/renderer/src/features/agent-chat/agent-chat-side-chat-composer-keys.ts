/**
 * Whether a key press in the side chat's input sends the question: Enter alone. Shift+Enter keeps its newline, and an
 * Enter that confirms an IME candidate (`isComposing`) is not a send.
 */
export function isAgentChatSideSendKey(event: {
    isComposing: boolean;
    key: string;
    shiftKey: boolean;
}): boolean {
    return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}

import { currentAgentChatPromptSuggestion } from '@caxri/protocol';

/**
 * The provider's suggested next message the phone's composer offers, or `undefined`. It follows Desktop's empty-input
 * offer (`agentChatComposerPrompt`): only while the suggestion is current (`currentAgentChatPromptSuggestion`, so no
 * turn runs and no newer reply landed), the input is empty and can send, and no edit or composer menu holds the input.
 * The phone has no Tab key, so the composer shows it as a chip the user taps to fill the input instead of a
 * placeholder.
 */
export function agentChatOfferedPromptSuggestion(state: {
    draft: string;
    isEditable: boolean;
    isEditing: boolean;
    isMenuOpen: boolean;
    snapshot: Parameters<typeof currentAgentChatPromptSuggestion>[0];
}): string | undefined {
    if (!state.isEditable || state.isEditing || state.isMenuOpen) return undefined;
    if (state.draft.length > 0) return undefined;
    return currentAgentChatPromptSuggestion(state.snapshot);
}

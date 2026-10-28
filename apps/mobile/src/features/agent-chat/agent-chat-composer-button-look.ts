/**
 * How the composer's main button looks for its current state, resolved apart from the component so the branching has a
 * test path and `AgentChatComposerButton` stays flat (react-doctor/no-high-complexity-react-function).
 */
export interface AgentChatComposerButtonLook {
    /**
     * Which surface color the button wears: `neutral` when it cannot act, otherwise `danger` for Stop and `primary` for
     * Send and Steer.
     */
    background: 'danger' | 'neutral' | 'primary';
    /**
     * The glyph shown while the button is neither busy nor a Steer pill.
     */
    icon: 'send' | 'steer' | 'stop';
    /**
     * A button that cannot act (offline, no access, an empty draft) drops the brand color for the neutral surface,
     * since a dimmed pink still read as enabled beside `Reconnect to send messages.`; busy keeps its color.
     */
    isDisabled: boolean;
    /**
     * Steer beside Queue wears a text label in Queue's pill shape; every other state is the round icon button.
     */
    isSteerPill: boolean;
}

export const agentChatComposerButtonLook = ({
    canQueue,
    canSubmit,
    isBusy,
    isRunning,
    kind,
}: {
    canQueue: boolean;
    canSubmit: boolean;
    isBusy: boolean;
    isRunning: boolean;
    kind: 'send' | 'stop';
}): AgentChatComposerButtonLook => {
    const isDisabled = !canSubmit && !isBusy;
    const isStop = kind === 'stop';
    const icon = isStop ? 'stop' : isRunning ? 'steer' : 'send';
    let background: AgentChatComposerButtonLook['background'] = 'primary';
    if (isDisabled) background = 'neutral';
    else if (isStop) background = 'danger';
    return { background, icon, isDisabled, isSteerPill: canQueue && isRunning && !isStop };
};

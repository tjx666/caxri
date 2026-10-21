/**
 * How the composer form's submitter asks for the message to go: `steer` from a Send button held with Cmd or Ctrl, which
 * turned into Steer and says so through its `delivery` value (`AgentChatSendButton`), else the composer's default.
 */
export function agentChatSubmitterDelivery(submitter: HTMLElement | null): 'steer' | undefined {
    return submitter && 'value' in submitter && submitter.value === 'steer' ? 'steer' : undefined;
}

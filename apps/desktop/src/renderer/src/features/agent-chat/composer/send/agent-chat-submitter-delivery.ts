/**
 * How the composer form's submitter asks for the message to go: the Send button's `delivery` value while a turn runs,
 * `steer`, or `queue` while Cmd or Ctrl is held (`AgentChatSendButton`), else the composer's default.
 */
export function agentChatSubmitterDelivery(
    submitter: HTMLElement | null,
): 'queue' | 'steer' | undefined {
    if (!submitter || !('value' in submitter)) return undefined;
    return submitter.value === 'queue' || submitter.value === 'steer' ? submitter.value : undefined;
}

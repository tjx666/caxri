import { agentChatLeadingInvocation } from '../agent-chat-slash-commands';

/**
 * A recognized `/command` or `$skill` at the start of the draft, as document offsets.
 */
export interface AgentChatInvocationRange {
    from: number;
    invocation: string;
    to: number;
}

/**
 * The leading invocation the composer draws as a chip, or `undefined` when the draft starts with plain text.
 *
 * Recognized means the menu offers it exactly (`known` holds `/compact` and `$commit` spellings), so an unknown `/foo`,
 * a path, or `$5` stays plain text, as the provider would treat it. A token still being typed stays editable text: when
 * it ends the draft with the caret touching it (`caret` inside or at its end), nothing follows to complete it, so the
 * chip appears once the user types a space or moves the caret away. The text is never rewritten; the chip is only a
 * view of it, so what is sent is unchanged.
 */
export function agentChatInvocationRange(
    text: string,
    known: ReadonlySet<string>,
    caret?: number,
): AgentChatInvocationRange | undefined {
    const leading = agentChatLeadingInvocation(text);
    if (!leading || !known.has(leading.invocation)) return undefined;
    const to = leading.invocation.length;
    const isTyping = to === text.length && caret !== undefined && caret <= to;
    return isTyping ? undefined : { from: 0, invocation: leading.invocation, to };
}

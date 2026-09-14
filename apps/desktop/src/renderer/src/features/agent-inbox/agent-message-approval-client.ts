import type { MethodResult } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';

/**
 * The Server reads the approval dialog issues. Keeping them here rather than in the component is the boundary
 * `caxri/server-reads-through-query` enforces: a request written inline in a component resolves into state that dies
 * with the component, and the next copy of that shape inherits the same defect.
 */
export async function listHeldAgentMessages(): Promise<
    MethodResult<'agent.message.held'>['messages']
> {
    const { messages } = await caxri.request('agent.message.held');
    return messages;
}

export function getHeldAgentMessage(
    messageId: string,
): Promise<MethodResult<'agent.message.held.get'>> {
    return caxri.request('agent.message.held.get', { messageId });
}

export async function settleHeldAgentMessage(
    action: 'approve' | 'deny',
    messageId: string,
): Promise<void> {
    await caxri.request(`agent.message.${action}`, { messageId });
}

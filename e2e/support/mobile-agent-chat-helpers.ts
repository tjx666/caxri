import type { AgentChatSnapshot } from '@caxri/protocol';

import {
    adbShell,
    mobileSemantics,
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

export const hasCheck = (nodes: Array<{ checkId: string }>, id: string): boolean =>
    nodes.some(({ checkId }) => checkId === id);

export const waitForCheck = (serial: string, id: string, timeoutMs = 30_000) =>
    waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => hasCheck(nodes, id),
        timeoutMs,
    );

export const waitForNoCheck = (serial: string, id: string, timeoutMs = 30_000) =>
    waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => !hasCheck(nodes, id),
        timeoutMs,
    );

export const agentText = (snapshot: AgentChatSnapshot): string =>
    snapshot.items
        .filter((item) => item.type === 'agentMessage')
        .map((item) => item.text)
        .join('\n');

/**
 * Sends one keyword message from the phone. The fake app-server picks its behavior from the keyword, and a single ASCII
 * word survives `input text` without the fixture IME.
 */
export async function sendFromPhone(serial: string, word: string): Promise<void> {
    await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
    await adbShell(serial, ['input', 'text', word]);
    const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
        kind: 'equals',
        value: word,
    });
    if (!draft.exists || !draft.textMatches) throw new Error('Chat draft did not match');
    await tapMobileCheck(serial, 'agent-chat-composer-send');
}

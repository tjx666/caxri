import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentChatSnapshot } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck, waitForCheck } from './mobile-agent-chat-helpers';
import {
    mobileSemantics,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

const PREVIEW_NOTE = 'agent-chat-image-viewer-preview-note';

const imageMessage = (snapshot: AgentChatSnapshot) =>
    snapshot.items.findLast(
        (item): item is Extract<AgentChatSnapshot['items'][number], { type: 'userMessage' }> =>
            item.type === 'userMessage' && (item.images?.length ?? 0) > 0,
    );

/**
 * `MOB-CHAT-IMAGE-PENDING-01`: an image steered into a running Claude turn shows in the Chat before Claude Code records
 * it (#3356). Opening it then keeps the viewer waiting on its preview instead of calling the original unavailable, and
 * the original replaces the preview once the turn ends and the message is recorded.
 */
export async function executeMobileChatImagePendingScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    const hold = join(fixture.testDirectory, 'hold-reply');
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        const data = (
            await readFile(join(import.meta.dirname, '../fixtures/mobile-acceptance-image.jpg'))
        ).toString('base64');
        await writeFile(hold, '');
        await chat.send({ text: 'think quietly' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.activeTurnId !== undefined,
        );
        // The fake Claude, like the real CLI, records a steered message only when the held turn takes it in.
        await chat.send({
            text: 'Look at this.',
            images: [
                { mediaType: 'image/jpeg', data, thumbnail: `data:image/jpeg;base64,${data}` },
            ],
            delivery: 'steer',
        });
        const steered = await waitForMobile(
            () => chat.read(),
            (snapshot) => imageMessage(snapshot) !== undefined,
        );
        const message = imageMessage(steered);
        if (!message) throw new Error('The steered image message did not reach the Chat');
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await tapMobileCheckByBounds(serial, `agent-chat-message-image-${message.id}-0`);
        await waitForCheck(serial, 'agent-chat-image-viewer-placeholder', 60_000);
        const waiting = await mobileSemantics(serial);
        if (hasCheck(waiting, PREVIEW_NOTE) || hasCheck(waiting, 'agent-chat-image-viewer-image'))
            throw new Error('The viewer called the original unavailable before it was recorded');
        await capture(environment, 'viewer-waiting', artifacts);

        await rm(hold);
        // The first poll comes 2 seconds after the pending answer and backs off from there.
        await waitForCheck(serial, 'agent-chat-image-viewer-image', 90_000);
        if (hasCheck(await mobileSemantics(serial), PREVIEW_NOTE))
            throw new Error('The viewer fell back to the preview after the message was recorded');
        await capture(environment, 'viewer-original', artifacts);
        await finish(environment, artifacts, { original: 'waited-then-shown', status: 'passed' });
    } finally {
        await rm(hold, { force: true });
        await fixture.stop();
    }
}

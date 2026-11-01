import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentChatSnapshot } from '@caxri/protocol';

import { writeJsonAtomic } from '../../scripts/atomic-json';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { agentText, hasCheck, waitForCheck } from './mobile-agent-chat-helpers';
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
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        const data = (
            await readFile(join(import.meta.dirname, '../fixtures/mobile-acceptance-image.jpg'))
        ).toString('base64');
        /**
         * A turn waiting on an approval stays running while the screen holds still; a streaming turn animates, which
         * keeps UIAutomator from reading the screen.
         */
        await chat.send({ text: 'approve' });
        const waiting = await waitForMobile(
            () => chat.read(),
            (snapshot) => snapshot.requests.length > 0,
        );
        const request = waiting.requests.at(0);
        if (!request) throw new Error('The approval did not reach the Chat');
        // The fake Claude, like the real CLI, records a steered message only when the running turn takes it in.
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
        const opened = await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, 'agent-chat-image-viewer-placeholder') ||
                hasCheck(nodes, PREVIEW_NOTE),
            60_000,
        );
        await capture(environment, 'viewer-waiting', artifacts);
        if (hasCheck(opened, PREVIEW_NOTE)) {
            // Keeps the frame citable in a failed baseline round, as the runner binds the manifest either way.
            await writeJsonAtomic(environment.artifactManifestPath, {
                artifacts,
                schemaVersion: 1,
            });
            throw new Error('The viewer called the original unavailable before it was recorded');
        }

        // Approving lets the turn finish, and the next turn takes the steered message in and records it.
        await chat.respond(request.id, { kind: 'decision', decision: 'accept' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId && agentText(snapshot).includes('Received 1 image.'),
            60_000,
        );
        // The viewer stayed open; its next read, at most 15 seconds after the last, finds the original.
        await waitForCheck(serial, 'agent-chat-image-viewer-image', 60_000);
        if (hasCheck(await mobileSemantics(serial), PREVIEW_NOTE))
            throw new Error('The viewer fell back to the preview after the message was recorded');
        await capture(environment, 'viewer-original', artifacts);
        await finish(environment, artifacts, { original: 'waited-then-shown', status: 'passed' });
    } finally {
        await fixture.stop();
    }
}

import type { AgentChatSnapshot } from '@caxri/protocol';

import { writeJsonAtomic } from '../../scripts/atomic-json';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck, waitForCheck } from './mobile-agent-chat-helpers';
import {
    mobileSemantics,
    observeMobileNode,
    startMobileFramebufferRecording,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import {
    addMobileGalleryImages,
    pickMobileGalleryImages,
    removeMobileGalleryImages,
} from './mobile-gallery';
import { insertMobileInputUnicode } from './mobile-unicode-input';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const TYPED = '看看这张图';
/**
 * The draft once the image is attached: its placeholder written at the cursor, a space on each side.
 */
const WITH_IMAGE = `${TYPED} [Image #1] `;

const sentImageMessage = (snapshot: AgentChatSnapshot) =>
    snapshot.items.findLast(
        (item): item is Extract<AgentChatSnapshot['items'][number], { type: 'userMessage' }> =>
            item.type === 'userMessage' && (item.images?.length ?? 0) > 0,
    );

/**
 * `MOB-CHAT-COMPOSER-IMAGES-01`: an image attached in the Chat composer is written into the draft as `[Image #1]` where
 * the cursor was and drawn as a pill, as on Desktop; on Send its thumbnail flies into the pending message while the
 * capsule eases back to one line, and the Agent receives the placeholder in the text. Before the change the image only
 * sat in the strip above the field and vanished on Send.
 */
export async function executeMobileChatComposerImagesScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath) throw new Error('MOB-CHAT-COMPOSER-IMAGES-01 records the send');
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await addMobileGalleryImages(serial);
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await insertMobileInputUnicode(serial, 'agent-chat-composer-input', TYPED, TYPED);
        await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
        await tapMobileCheck(serial, 'image-source-library');
        await pickMobileGalleryImages(serial);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, 'session-image-open-0') &&
                !hasCheck(nodes, 'session-image-status-0'),
            120_000,
        );
        // Captured before the check, so a baseline round still shows the composer it replaced.
        await capture(environment, 'composer-image-pill', artifacts);
        const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: WITH_IMAGE,
        });
        if (!draft.exists || draft.textMatches !== true) {
            await writeJsonAtomic(environment.artifactManifestPath, {
                artifacts,
                schemaVersion: 1,
            });
            throw new Error('Attaching the image did not write its placeholder at the cursor');
        }

        // The recording spans only the send, so it shows the flight and the capsule settling, and no reply text.
        const recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        try {
            await pause(800);
            await tapMobileCheckByBounds(serial, 'agent-chat-composer-send');
            await pause(2500);
        } finally {
            await recording.stop();
        }
        const sent = await waitForMobile(
            () => chat.read(),
            (snapshot) => sentImageMessage(snapshot) !== undefined,
            60_000,
        );
        const message = sentImageMessage(sent);
        if (!message?.text.includes('[Image #1]'))
            throw new Error('The sent message lost the image placeholder');
        await capture(environment, 'sent-message', artifacts);
        await finish(environment, artifacts, { motion: 'live', status: 'passed' });
    } finally {
        await removeMobileGalleryImages(serial);
        await fixture.stop();
    }
}

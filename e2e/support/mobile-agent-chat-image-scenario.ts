import type { AgentChatSnapshot } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { agentText, hasCheck, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    androidBounds,
    mobileSemantics,
    setMobileNetworkAvailable,
    tapMobileCheck,
    tapMobileCheckByBounds,
    tapMobileNativeControl,
    waitForMobile,
} from './mobile-android';
import { addMobileGalleryImage, removeMobileGalleryImage } from './mobile-gallery';

const VIEWER_IMAGE = 'agent-chat-image-viewer-image';

/**
 * The newest user message that carried images, as the Server's own Chat projection records it.
 */
const imageMessage = (snapshot: AgentChatSnapshot) =>
    snapshot.items.findLast(
        (item): item is Extract<AgentChatSnapshot['items'][number], { type: 'userMessage' }> =>
            item.type === 'userMessage' && (item.images?.length ?? 0) > 0,
    );

async function checkBounds(serial: string, id: string) {
    const node = (await mobileSemantics(serial)).find(({ checkId }) => checkId === id);
    return (node && androidBounds(node.bounds)) ?? undefined;
}

/**
 * Double-taps the viewer's picture in one device shell so both taps land inside the gesture's double-tap window, then
 * waits until the picture's on-screen bounds grow past the fitted size.
 */
async function zoomViewer(serial: string): Promise<void> {
    const fitted = await checkBounds(serial, VIEWER_IMAGE);
    if (!fitted) throw new Error('The full-size image is not laid out');
    const x = Math.floor((fitted.left + fitted.right) / 2);
    const y = Math.floor((fitted.top + fitted.bottom) / 2);
    await adbShell(serial, ['sh', '-c', `input tap ${x} ${y}; input tap ${x} ${y}`]);
    await waitForMobile(
        () => checkBounds(serial, VIEWER_IMAGE),
        (bounds) => bounds !== undefined && bounds.right - bounds.left > fitted.right - fitted.left,
    );
}

/**
 * `MOB-CHAT-05`: the phone attaches a gallery photo to a Claude Code Chat, sends it alone, sees the sent message's
 * thumbnail, opens the original full screen and zooms it, and keeps the conversation's images readable but the attach
 * button disabled while offline.
 */
export async function executeMobileChatImageScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    let isNetworkDisabled = false;
    try {
        await addMobileGalleryImage(serial);
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await waitForCheck(serial, 'agent-chat-attach-image');
        await capture(environment, 'composer-empty', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
        await waitForCheck(serial, 'image-source-library');
        await capture(environment, 'image-sources', artifacts);
        await tapMobileCheck(serial, 'image-source-library');
        await tapMobileNativeControl(serial, { singleImageTile: true });
        // A ready attachment drops its progress scrim, leaving only its remove control.
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, 'session-image-remove-0') &&
                !hasCheck(nodes, 'session-image-status-0'),
        );
        await capture(environment, 'attached', artifacts);

        // An image alone is a message, as on Desktop.
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-send');
        const sent = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                imageMessage(snapshot) !== undefined &&
                agentText(snapshot).includes('Received 1 image.') &&
                !snapshot.activeTurnId,
        );
        const message = imageMessage(sent);
        if (!message) throw new Error('The image message did not reach the Chat');
        const thumbnail = `agent-chat-message-thumbnail-${message.id}-0`;
        await waitForCheck(serial, thumbnail);
        await waitForNoCheck(serial, 'session-image-remove-0');
        await capture(environment, 'sent', artifacts);

        await tapMobileCheckByBounds(serial, `agent-chat-message-image-${message.id}-0`);
        await waitForCheck(serial, VIEWER_IMAGE, 60_000);
        await capture(environment, 'viewer', artifacts);
        await zoomViewer(serial);
        await capture(environment, 'viewer-zoomed', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-image-viewer-close');
        await waitForNoCheck(serial, 'agent-chat-image-viewer');

        await setMobileNetworkAvailable(serial, false);
        isNetworkDisabled = true;
        await waitForCheck(serial, 'connection-stale-banner', 60_000);
        const offline = await mobileSemantics(serial);
        const attach = offline.find(({ checkId }) => checkId === 'agent-chat-attach-image');
        if (!hasCheck(offline, thumbnail) || attach?.enabled !== false)
            throw new Error(
                'Offline, sent images must stay visible and attaching must be disabled',
            );
        await capture(environment, 'offline', artifacts);
        await setMobileNetworkAvailable(serial, true);
        isNetworkDisabled = false;
        await waitForNoCheck(serial, 'connection-stale-banner', 60_000);

        await finish(environment, artifacts, {
            imageMessage: 'received',
            status: 'passed',
            viewer: 'zoomed',
        });
    } finally {
        if (isNetworkDisabled) {
            try {
                await setMobileNetworkAvailable(serial, true);
            } catch {
                // Teardown must still stop the fixture; the scenario's own failure is the useful error.
            }
        }
        await fixture.stop();
        await removeMobileGalleryImage(serial);
    }
}

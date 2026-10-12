import type { AgentChatSnapshot } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { agentText, hasCheck, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    androidBounds,
    captureMobileFramebuffer,
    mobileRegionFingerprint,
    mobileSemantics,
    setMobileNetworkAvailable,
    tapMobileCheck,
    tapMobileCheckByBounds,
    tapMobileNativeControl,
    waitForMobile,
} from './mobile-android';
import { addMobileGalleryImage, removeMobileGalleryImage } from './mobile-gallery';
import { pinchWithin } from './mobile-native-pinch';

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
 * Pinches the viewer's picture open, then waits until it has grown into a band above the fitted square fixture and
 * settled there. The picture's own node fills the viewer at any scale, so only its pixels show the zoom.
 */
async function zoomViewer(serial: string): Promise<void> {
    const viewer = await checkBounds(serial, VIEWER_IMAGE);
    if (!viewer) throw new Error('The full-size image is not laid out');
    const height = viewer.bottom - viewer.top;
    const band = {
        left: viewer.left,
        right: viewer.right,
        top: viewer.top + Math.floor(height * 0.2),
        bottom: viewer.top + Math.floor(height * 0.22),
    };
    const fitted = await mobileRegionFingerprint(serial, band);
    /**
     * Two `input tap` commands never registered as a double tap in the emulator, so the zoom is proven with the real
     * two-pointer pinch the Terminal scenarios already inject.
     */
    await pinchWithin(serial, 'pinch-out', viewer);
    let previous = fitted;
    await waitForMobile(
        () => mobileRegionFingerprint(serial, band),
        (current) => {
            const isSettled = current !== fitted && current === previous;
            previous = current;
            return isSettled;
        },
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
        // A resumed Claude transcript keeps the original, so the viewer shows it rather than the preview fallback.
        if (hasCheck(await mobileSemantics(serial), 'agent-chat-image-viewer-preview-note'))
            throw new Error('The viewer fell back to the preview instead of the original');
        await capture(environment, 'viewer', artifacts);
        try {
            await zoomViewer(serial);
        } catch (error) {
            // Diagnostic frame outside the report, so a missed gesture can be told apart from a missed detection.
            await captureMobileFramebuffer(serial, '/tmp/mob-chat-05-zoom-timeout.png');
            throw error;
        }
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
        try {
            await fixture.stop();
        } finally {
            await removeMobileGalleryImage(serial);
        }
    }
}

/**
 * How many copies of the gallery photo `MOB-CHAT-12` attaches: more than the phone's width holds, so the strip scrolls.
 */
const STRIP_IMAGE_COUNT = 6;

/**
 * Attaches the gallery's one photo through the image source sheet and the system Photo Picker, and waits until the
 * `index`th attachment is ready.
 */
async function attachGalleryImage(serial: string, index: number): Promise<void> {
    await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
    await waitForCheck(serial, 'image-source-library');
    await tapMobileCheck(serial, 'image-source-library');
    await tapMobileNativeControl(serial, { singleImageTile: true });
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            hasCheck(nodes, 'session-image-attachments') &&
            nodes.every(({ checkId }) => !checkId.startsWith('session-image-status-')) &&
            (index === 0 || !hasCheck(nodes, 'image-source-library')),
        60_000,
    );
}

/**
 * `MOB-CHAT-12`: the phone attaches more images than its width holds (#1763). The attachment strip scrolls sideways to
 * reach the last one, each image keeps its remove control (#1825), and the message sends with every image.
 */
export async function executeMobileChatImageStripScenario(
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
        await addMobileGalleryImage(serial);
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await waitForCheck(serial, 'agent-chat-attach-image');
        for (let index = 0; index < STRIP_IMAGE_COUNT; index += 1) {
            // eslint-disable-next-line no-await-in-loop -- each pick goes through the same native picker in turn.
            await attachGalleryImage(serial, index);
        }
        const strip = await checkBounds(serial, 'session-image-attachments');
        if (!strip) throw new Error('The attachment strip is not laid out');
        await adbShell(serial, [
            'input',
            'swipe',
            String(strip.right - 40),
            String(Math.floor((strip.top + strip.bottom) / 2)),
            String(strip.left + 40),
            String(Math.floor((strip.top + strip.bottom) / 2)),
            '400',
        ]);
        await waitForCheck(serial, `session-image-remove-${STRIP_IMAGE_COUNT - 1}`);
        await capture(environment, 'strip-end', artifacts);
        await adbShell(serial, [
            'input',
            'swipe',
            String(strip.left + 40),
            String(Math.floor((strip.top + strip.bottom) / 2)),
            String(strip.right - 40),
            String(Math.floor((strip.top + strip.bottom) / 2)),
            '400',
        ]);
        await waitForCheck(serial, 'session-image-remove-0');
        await capture(environment, 'strip-start', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-chat-composer-send');
        const sent = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                (imageMessage(snapshot)?.images?.length ?? 0) === STRIP_IMAGE_COUNT &&
                agentText(snapshot).includes(`Received ${STRIP_IMAGE_COUNT} images.`) &&
                !snapshot.activeTurnId,
            60_000,
        );
        const message = imageMessage(sent);
        if (!message) throw new Error('The image message did not reach the Chat');
        await waitForCheck(serial, `agent-chat-message-thumbnail-${message.id}-0`);
        await waitForNoCheck(serial, 'session-image-attachments');
        await capture(environment, 'sent', artifacts);

        await finish(environment, artifacts, {
            attached: STRIP_IMAGE_COUNT,
            status: 'passed',
            strip: 'scrolled',
        });
    } finally {
        try {
            await fixture.stop();
        } finally {
            await removeMobileGalleryImage(serial);
        }
    }
}

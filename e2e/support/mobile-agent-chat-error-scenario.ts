import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentChatSnapshot } from '@caxri/protocol';

import { allowE2EErrors } from './error-gate.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck, sendFromPhone, waitForCheck, waitForNoCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileSemantics,
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    tapMobileNativeControl,
    waitForMobile,
} from './mobile-android';
import { addMobileGalleryImage, removeMobileGalleryImage } from './mobile-gallery';

type ChatFixture = Awaited<ReturnType<typeof createMobileAcceptanceFixture>>;

/**
 * The newest user message that carried images, as the Server's own Chat projection records it.
 */
const imageMessage = (snapshot: AgentChatSnapshot) =>
    snapshot.items.findLast(
        (item): item is Extract<AgentChatSnapshot['items'][number], { type: 'userMessage' }> =>
            item.type === 'userMessage' && (item.images?.length ?? 0) > 0,
    );

/**
 * Pairs and opens the fixture's Chat, returning its Server-side reader.
 */
async function openChat(serial: string, fixture: ChatFixture) {
    await fixture.pair();
    const chat = fixture.agentChat;
    if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
    await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
    await waitForCheck(serial, 'agent-chat-attach-image');
    return chat;
}

/**
 * Pairs, opens the fixture's Chat, attaches the gallery photo with `text` beside it, sends it, and returns the sent
 * message once its reply has finished.
 */
async function sendGalleryImage(
    serial: string,
    fixture: ChatFixture,
    text: string,
): Promise<NonNullable<ReturnType<typeof imageMessage>>> {
    const chat = await openChat(serial, fixture);
    await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
    await waitForCheck(serial, 'image-source-library');
    await tapMobileCheck(serial, 'image-source-library');
    await tapMobileNativeControl(serial, { singleImageTile: true });
    await waitForMobile(
        () => mobileSemantics(serial),
        (nodes) =>
            hasCheck(nodes, 'session-image-remove-0') && !hasCheck(nodes, 'session-image-status-0'),
    );
    if (text) {
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
        await adbShell(serial, ['input', 'text', text]);
        const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: text,
        });
        if (!draft.exists || !draft.textMatches) throw new Error('Chat draft did not match');
    }
    await tapMobileCheckByBounds(serial, 'agent-chat-composer-send');
    const sent = await waitForMobile(
        () => chat.read(),
        (snapshot) => imageMessage(snapshot) !== undefined && !snapshot.activeTurnId,
    );
    const message = imageMessage(sent);
    if (!message) throw new Error('The image message did not reach the Chat');
    await waitForCheck(serial, `agent-chat-message-image-${message.id}-0`);
    await waitForNoCheck(serial, 'session-image-remove-0');
    return message;
}

/**
 * `MOB-CHAT-07`: in a Claude Code Chat whose record no longer holds an image's original, the viewer shows the sent
 * thumbnail with a note saying so. The fake CLI's `drop-images` control file leaves the image out of its transcript, as
 * the real record does once the original is gone.
 */
export async function executeMobileChatPreviewScenario(
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
        await writeFile(join(fixture.testDirectory, 'drop-images'), '');
        const message = await sendGalleryImage(serial, fixture, '');
        await waitForCheck(serial, `agent-chat-message-thumbnail-${message.id}-0`);
        await capture(environment, 'sent', artifacts);

        await tapMobileCheckByBounds(serial, `agent-chat-message-image-${message.id}-0`);
        await waitForCheck(serial, 'agent-chat-image-viewer-preview-note', 60_000);
        await waitForCheck(serial, 'agent-chat-image-viewer-image');
        await capture(environment, 'viewer-preview', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-image-viewer-close');
        await waitForNoCheck(serial, 'agent-chat-image-viewer');

        await finish(environment, artifacts, { status: 'passed', viewer: 'preview-fallback' });
    } finally {
        try {
            await fixture.stop();
        } finally {
            await removeMobileGalleryImage(serial);
        }
    }
}

/**
 * `MOB-CHAT-08`: a Codex Chat image whose thumbnail Server Core no longer holds, as after a restart, shows an empty
 * tile, and opening it says the image is no longer available, since the fake app-server writes no rollout to read the
 * original back from.
 */
export async function executeMobileChatMissingImageScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'agent-chat', serial });
    try {
        await addMobileGalleryImage(serial);
        // The fake app-server echoes a message containing `unpaired` without the id that pairs its thumbnail.
        const message = await sendGalleryImage(serial, fixture, 'unpaired');
        const thumbnail = `agent-chat-message-thumbnail-${message.id}-0`;
        await capture(environment, 'sent', artifacts);

        await tapMobileCheckByBounds(serial, `agent-chat-message-image-${message.id}-0`);
        await waitForCheck(serial, 'agent-chat-image-viewer-error', 60_000);
        const nodes = await mobileSemantics(serial);
        if (
            hasCheck(nodes, 'agent-chat-image-viewer-retry') ||
            hasCheck(nodes, 'agent-chat-image-viewer-image')
        )
            throw new Error('A missing image must not offer Retry or show a picture');
        await capture(environment, 'viewer-missing', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-image-viewer-close');
        await waitForNoCheck(serial, 'agent-chat-image-viewer');
        // Checked after the viewer round trip, so a merely slow thumbnail cannot pass for a missing one.
        if (hasCheck(await mobileSemantics(serial), thumbnail))
            throw new Error('The tile showed a thumbnail the Server no longer holds');
        await capture(environment, 'closed', artifacts);

        await finish(environment, artifacts, { status: 'passed', viewer: 'no-longer-available' });
    } finally {
        try {
            await fixture.stop();
        } finally {
            await removeMobileGalleryImage(serial);
        }
    }
}

/**
 * `MOB-CHAT-09`: when Claude Code refuses a model change, the sheet says so in Desktop's words, keeps the model in use
 * checked, and the Chat keeps running that model. The fake CLI's `reject-model-change` control file makes `set_model`
 * answer with an error, as the real CLI does.
 */
export async function executeMobileChatModelRefusedScenario(
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
        const chat = await openChat(serial, fixture);
        // Claude Code names its model in the first turn's init message.
        await sendFromPhone(serial, 'hello');
        const ready = await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                snapshot.model !== undefined &&
                snapshot.turns.at(-1)?.status === 'completed' &&
                !snapshot.activeTurnId,
        );
        await waitForNoCheck(serial, 'agent-chat-activity');
        await tapMobileCheckByBounds(serial, 'agent-chat-model-button');
        await waitForCheck(serial, 'agent-chat-model-sheet');
        const checkedModel = async () =>
            (await mobileSemantics(serial)).find(
                ({ checked, checkId }) => checked && checkId.startsWith('agent-chat-model-'),
            )?.checkId;
        const before = await checkedModel();
        if (!before || before === 'agent-chat-model-opus')
            throw new Error('The sheet did not mark the model in use');
        await capture(environment, 'sheet', artifacts);

        // The refused `set_model` reaches the phone as a failed `agentChat.configure` request.
        allowE2EErrors([
            {
                source: 'server-core',
                event: 'ipc.request_failed',
                code: 'INTERNAL',
                count: 1,
            },
        ]);
        await writeFile(join(fixture.testDirectory, 'reject-model-change'), '');
        await tapMobileCheckByBounds(serial, 'agent-chat-model-opus');
        await waitForCheck(serial, 'agent-chat-model-error');
        if ((await checkedModel()) !== before)
            throw new Error('A refused model change moved the checkmark');
        const refused = await chat.read();
        if (refused.model !== ready.model)
            throw new Error('A refused model change changed the model the Chat runs');
        await capture(environment, 'model-error', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-model-done');
        await waitForNoCheck(serial, 'agent-chat-model-sheet');
        await capture(environment, 'model-kept', artifacts);

        await finish(environment, artifacts, {
            model: { after: refused.model, before: ready.model },
            modelChange: 'refused-and-kept',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

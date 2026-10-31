import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { parseAgentChatPathReferences } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { hasCheck, waitForCheck } from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileSemantics,
    pushMobileFixture,
    tapMobileCheck,
    tapMobileCheckByBounds,
    tapMobileNativeControl,
    waitForMobile,
} from './mobile-android';

const FILE_NAME = 'caxri-acceptance-document.pdf';
const REMOTE_FILE = `/sdcard/Download/${FILE_NAME}`;

/**
 * A synthetic PDF large enough to upload in several chunks, so the Server assembles it from pieces sent in parallel.
 */
const acceptancePdf = (): Buffer =>
    Buffer.concat([
        Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n'),
        Buffer.from(`%${'caxri acceptance padding '.repeat(6_000)}\n`),
        Buffer.from('trailer << /Root 1 0 R >>\n%%EOF\n'),
    ]);

const rescan = (serial: string) =>
    adbShell(serial, [
        'am',
        'broadcast',
        '-a',
        'android.intent.action.MEDIA_SCANNER_SCAN_FILE',
        '-d',
        `file://${REMOTE_FILE}`,
    ]);

/**
 * The newest user message that cited files, as the Server's own Chat projection records it.
 */
const fileMessage = (snapshot: AgentChatSnapshot) =>
    snapshot.items.findLast(
        (item): item is Extract<AgentChatSnapshot['items'][number], { type: 'userMessage' }> =>
            item.type === 'userMessage' &&
            parseAgentChatPathReferences(item.text).references.length > 0,
    );

/**
 * `MOB-CHAT-FILE-01`: the phone attaches a PDF from the system Files picker to a Claude Code Chat, waits for its card
 * to finish uploading, sends it alone, and sees the sent message cite it as a file chip. The cited path holds the same
 * bytes the phone picked.
 */
export async function executeMobileChatFileScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        mode: 'agent-chat',
        serial,
    });
    const directory = await mkdtemp(join(tmpdir(), 'caxri-mobile-file-'));
    const pdf = acceptancePdf();
    try {
        const local = join(directory, FILE_NAME);
        await writeFile(local, pdf);
        await pushMobileFixture(serial, local, REMOTE_FILE);
        await rescan(serial);
        await fixture.pair();
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await tapMobileCheck(serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');

        await tapMobileCheckByBounds(serial, 'agent-chat-attach-image');
        await waitForCheck(serial, 'image-source-files');
        await capture(environment, 'sources', artifacts);
        await tapMobileCheck(serial, 'image-source-files');
        // The system Files picker lists the download among its recent files; a tap returns it.
        await tapMobileNativeControl(serial, { text: FILE_NAME });
        // Send turns on once the card's upload has finished.
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                nodes.some(({ checkId }) => checkId.startsWith('session-file-remove-')) &&
                nodes.find(({ checkId }) => checkId === 'agent-chat-composer-send')?.enabled ===
                    true,
            90_000,
        );
        await capture(environment, 'attached', artifacts);

        // A file alone is a message, as an image is.
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-send');
        const sent = await waitForMobile(
            () => chat.read(),
            (snapshot) => fileMessage(snapshot) !== undefined && !snapshot.activeTurnId,
            90_000,
        );
        const message = fileMessage(sent);
        if (!message) throw new Error('The file message did not reach the Chat');
        const [reference] = parseAgentChatPathReferences(message.text).references;
        if (!reference.path.endsWith(`/${FILE_NAME}`))
            throw new Error('The message cites a different file');
        if (!(await readFile(reference.path)).equals(pdf))
            throw new Error('The uploaded file differs from the picked one');
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) =>
                hasCheck(nodes, 'agent-chat-path-chips') &&
                nodes.every(({ checkId }) => !checkId.startsWith('session-file-remove-')),
        );
        await capture(environment, 'sent', artifacts);

        await finish(environment, artifacts, {
            fileMessage: 'cited',
            status: 'passed',
            upload: 'identical',
        });
    } finally {
        try {
            await adbShell(serial, ['rm', '-f', REMOTE_FILE]);
            await rescan(serial);
            await rm(directory, { recursive: true, force: true });
        } finally {
            await fixture.stop();
        }
    }
}

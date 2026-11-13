import { writeFile } from 'node:fs/promises';

import { openAgentChat } from './support/agent-chat-fixture.ts';
import { selectSession } from './support/delegated-sessions-fixture.ts';
import {
    caxriCliCommand,
    createParentSession,
    launchDelegatingChat,
} from './support/delegating-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { pageRequest, VISIBLE_SESSION } from './support/helpers.ts';

const RELAY_PROMPT = 'tell the diagnostics Session to drop the pin';
const RELAYED_TEXT = 'Drop the dependency pin from the pull request.';
const TARGET_REPLY = 'Dropping the pin now.';

/**
 * The user asks the Agent in one Session to pass a message on to another Session the user opened themselves. The Agent
 * relays it through the real CLI, and the other Session's idle Chat starts a turn with it, labeled with its source, as
 * if the user had typed it there and pressed Enter.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test("an Agent relays a message into another of the user's Sessions as a new turn", async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-session-relay-');
    try {
        const { page } = chat.running;
        const { projectId, sessionId: targetId } = await createParentSession(chat);
        await pageRequest(page, 'session.rename', {
            sessionId: targetId,
            title: 'Diagnostics export',
        });
        const created = await pageRequest<{ session: { id: string } }>(page, 'session.create', {
            projectId,
            defaultAgent: 'shell',
        });
        const sourceId = created.session.id;
        await pageRequest(page, 'session.rename', { sessionId: sourceId, title: 'Fix sign-in' });
        const relay = caxriCliCommand(
            `agent session send ${targetId} --text "${RELAYED_TEXT}" --json`,
        );
        // Every Chat reads this script once when it starts, so it is written before either opens.
        await writeFile(
            chat.scriptPath,
            JSON.stringify({
                turns: [
                    {
                        prompt: RELAY_PROMPT,
                        steps: [
                            { kind: 'command', command: relay, output: '', shouldRun: true },
                            { kind: 'message', text: 'Relayed it.' },
                        ],
                    },
                    {
                        prompt: '[Caxri] Relayed from',
                        isPrefix: true,
                        steps: [{ kind: 'message', text: TARGET_REPLY }],
                    },
                ],
            }),
        );
        const session = page.locator(VISIBLE_SESSION);

        await selectSession(page, targetId);
        await openAgentChat(page, 'Codex Chat');
        await selectSession(page, sourceId);
        await openAgentChat(page, 'Codex Chat');
        const message = session.getByRole('textbox', { name: 'Message' });
        await message.fill(RELAY_PROMPT);
        await message.press('Enter');
        await expect(session.getByText('Relayed it.')).toBeVisible();

        await selectSession(page, targetId);
        await expect(
            session.getByText(`[Caxri] Relayed from Session "Fix sign-in" at the user's request:`),
        ).toBeVisible();
        await expect(session.getByText(RELAYED_TEXT)).toBeVisible();
        await expect(session.getByText(TARGET_REPLY)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('relayed-target-session.png') });
    } finally {
        await chat.cleanup();
    }
});

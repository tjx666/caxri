import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type { BootstrapState } from '@caxri/protocol';

import { openAgentChat } from './support/agent-chat-fixture.ts';
import { selectSession } from './support/delegated-sessions-fixture.ts';
import type { DelegatingChat } from './support/delegating-chat-fixture.ts';
import {
    CHILD_SUMMARY,
    CHILD_TITLE,
    createParentSession,
    DELEGATE_PROMPT,
    HOLD_CHILD_FILE,
    launchDelegatingChat,
} from './support/delegating-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { pageRequest, VISIBLE_SESSION } from './support/helpers.ts';
import { runServerDatabase } from './support/run-server-database.ts';
import type { StoredQuestionRead } from './support/server-database/delegation-question.ts';

const QUESTION = 'Which retry policy should the design use?';
const ANSWER = 'Use exponential backoff, capped at five tries.';
const OPTIONS = ['Exponential backoff', 'Fixed delay'];

/**
 * Replaces the fixture's script with one whose child asks the Agent that delegated it before it works, holds, then
 * waits for the answer. The question ID is dynamic, so the child's commands pass it through files in the control
 * directory (`ask.json`, `wait.json`); the script itself is static JSON.
 */
async function writeAskingScript(chat: DelegatingChat, projectId: string) {
    const cli = [process.execPath, join(import.meta.dirname, '..', 'apps/cli/dist/caxri.cjs')].join(
        ' ',
    );
    const askFile = join(chat.controlDirectory, 'ask.json');
    const waitFile = join(chat.controlDirectory, 'wait.json');
    const create = [
        cli,
        'agent delegate create',
        `--project ${projectId} --new-session --title "${CHILD_TITLE}"`,
        `--provider codex --prompt-file ${chat.taskPath} --request-id e2e-delegated-ask --json`,
    ].join(' ');
    const ask = [
        cli,
        'agent delegate ask',
        `--text "${QUESTION}"`,
        ...OPTIONS.map((option) => `--option "${option}"`),
        `--request-id e2e-ask --json > ${askFile}`,
    ].join(' ');
    const questionId = String.raw`$(sed -n 's/.*"questionId": *"\([^"]*\)".*/\1/p' ${askFile} | head -1)`;
    const wait = `${cli} agent delegate ask-wait ${questionId} --timeout 20000 --json > ${waitFile}`;
    await writeFile(
        chat.scriptPath,
        JSON.stringify({
            turns: [
                {
                    prompt: DELEGATE_PROMPT,
                    steps: [
                        { kind: 'command', command: 'echo preparing', output: 'preparing' },
                        { kind: 'command', command: create, output: '', shouldRun: true },
                        { kind: 'message', text: 'Delegated the review to a new Session.' },
                    ],
                },
                {
                    prompt: 'Read the delegated task from ',
                    isPrefix: true,
                    steps: [
                        { kind: 'command', command: ask, output: '', shouldRun: true },
                        { kind: 'hold', file: HOLD_CHILD_FILE },
                        { kind: 'command', command: wait, output: '', shouldRun: true },
                        {
                            kind: 'message',
                            text: `Reviewed the retry design.\n\nSummary: ${CHILD_SUMMARY}`,
                        },
                    ],
                },
            ],
        }),
    );
}

/**
 * Delegates through the parent Chat and waits until the child's question is stored. The child is held after asking, so
 * the question stays open for as long as the spec needs.
 */
async function delegateAndAsk(chat: DelegatingChat) {
    const { page } = chat.running;
    const { projectId, sessionId: parentId } = await createParentSession(chat);
    const parent = (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
        (session) => session.id === parentId,
    )!;
    await writeAskingScript(chat, projectId);
    await writeFile(join(chat.controlDirectory, HOLD_CHILD_FILE), '');
    await openAgentChat(page, 'Codex Chat');
    const session = page.locator(VISIBLE_SESSION);
    const message = session.getByRole('textbox', { name: 'Message' });
    await message.fill(DELEGATE_PROMPT);
    await message.press('Enter');
    const strip = session.getByRole('region', { name: 'Delegated Sessions' });
    const row = strip.locator('[data-agent-chat-delegated-session]');
    await expect(row).toContainText(CHILD_TITLE);
    const childId = (await row.getAttribute('data-agent-chat-delegated-session'))!;
    let questionId = '';
    await expect
        .poll(async () => {
            const open = await runServerDatabase<string | null>('delegation-question', {
                action: 'open',
                userData: chat.userData,
                sessionId: childId,
            });
            questionId = open ?? '';
            return open !== null;
        })
        .toBe(true);
    return { childId, parent, parentId, questionId, row, session, strip };
}

/**
 * A question is inline only: neither the delegating Session nor the asking child gains a `waiting` attention kind (the
 * source of every needs-input notification and sidebar marker). A finished turn's `completed` kind is unrelated.
 */
async function expectNoAttention(page: Parameters<typeof pageRequest>[0], ...sessionIds: string[]) {
    const { sessions } = await pageRequest<BootstrapState>(page, 'app.bootstrap');
    for (const id of sessionIds)
        expect(sessions.find((session) => session.id === id)?.lastAttentionKind).not.toBe(
            'waiting',
        );
}

function readQuestion(chat: DelegatingChat, questionId: string) {
    return runServerDatabase<StoredQuestionRead | null>('delegation-question', {
        action: 'read',
        userData: chat.userData,
        questionId,
    });
}

/**
 * Every file under the profile's log directory, concatenated: the question and the answer must be in none of them.
 */
async function readLogs(userData: string): Promise<string> {
    const directory = join(userData, 'logs');
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const contents = await Promise.all(
        entries
            .filter((entry) => entry.isFile())
            .map((entry) => readFile(join(entry.parentPath, entry.name), 'utf8')),
    );
    return contents.join('\n');
}

/**
 * The file's text, or an empty string while the child has not written it yet.
 */
async function readWhenWritten(path: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
    }
}

/**
 * The asking child, the user answering from its Chat, and the child resuming with that answer. The parent's fake Agent
 * cannot answer (the IDs are dynamic), so the user's answer path is the one under test; the parent answering is covered
 * by the Server integration tests.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a delegated Agent asks, the user answers from the child Chat, and the child continues', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-ask-');
    try {
        const { page } = chat.running;
        const { childId, parent, questionId, row, session, strip } = await delegateAndAsk(chat);

        // Within the grace the question is the parent's: muted, no amber, nothing that asks for attention.
        await expect(row).toContainText('Asking the Agent that delegated it');
        await expect(row.locator('[data-agent-chat-delegation-glyph="asking"]')).toBeVisible();
        await expect(strip).toContainText('1 asking');
        await expect(strip).not.toContainText('needs input');
        await expect(
            session.locator('[data-agent-chat-delegation-glyph="needsInput"]'),
        ).toHaveCount(0);
        await expectNoAttention(page, parent.id, childId);
        await page.screenshot({ path: testInfo.outputPath('delegated-asking.png') });

        // The child's origin row says who it waits for and offers the user the answer.
        await selectSession(page, childId);
        const origin = session.locator('[data-agent-chat-delegation-origin="delegated"]');
        await expect(origin).toContainText(`Waiting for ${parent.title} to answer`);
        const card = origin.locator('[data-delegation-question="offer"]');
        await expect(card).toContainText(QUESTION);
        await card.getByRole('button', { name: 'I will answer' }).click();
        const send = card.getByRole('button', { name: 'Send answer' });
        await expect(send).toBeDisabled();
        await card.getByRole('button', { name: OPTIONS[0] }).click();
        const field = card.getByRole('textbox', { name: 'Type your answer' });
        await expect(field).toHaveValue(OPTIONS[0]);
        await field.fill(ANSWER);
        await page.screenshot({ path: testInfo.outputPath('delegated-answering.png') });
        await send.click();
        await expect(card).toHaveCount(0);

        // The answer is stored as the user's, and a late second answer is refused without overwriting it.
        await expect
            .poll(async () => (await readQuestion(chat, questionId))?.state)
            .toBe('answered');
        expect(await readQuestion(chat, questionId)).toMatchObject({
            answeredBy: 'user',
            answerText: ANSWER,
        });
        const { delegations } = await pageRequest<{ delegations: Array<{ delegationId: string }> }>(
            page,
            'agent.delegation.list',
            { active: true, limit: 1 },
        );
        const late = await pageRequest<{ outcome: string }>(page, 'agent.delegation.answer', {
            delegationId: delegations[0].delegationId,
            questionId,
            text: 'A second answer',
        });
        expect(late.outcome).toBe('already_answered');
        expect((await readQuestion(chat, questionId))?.answerText).toBe(ANSWER);

        // Released, the child receives the answer through ask-wait and finishes its task.
        await rm(join(chat.controlDirectory, HOLD_CHILD_FILE));
        await expect
            .poll(() => readWhenWritten(join(chat.controlDirectory, 'wait.json')))
            .toContain(ANSWER);
        await selectSession(page, parent.id);
        await expect(strip.locator('[data-agent-chat-delegated-session]')).toContainText(
            CHILD_SUMMARY,
        );
        await expect(strip).not.toContainText('asking');

        // Question and answer text never reach a log.
        const logs = await readLogs(chat.userData);
        expect(logs).not.toContain(QUESTION);
        expect(logs).not.toContain(ANSWER);
        expect(logs).not.toContain('A second answer');
    } finally {
        await chat.cleanup();
    }
});

/**
 * An unanswered question becomes the user's: amber row and an open answer field. Then the user types in the child
 * instead, which takes the Session over and withdraws the question.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('an escalated question is the user to answer, and taking the child over withdraws it', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-escalated-');
    try {
        const { page } = chat.running;
        const { childId, parent, questionId, row, session, strip } = await delegateAndAsk(chat);

        // The 600 s grace is not waited out: the stored question is escalated and the Renderer reads the feed again.
        await runServerDatabase('delegation-question', {
            action: 'escalate',
            userData: chat.userData,
            sessionId: childId,
        });
        await page.reload();
        await expect(strip).toContainText('1 needs input');
        await expect(strip).not.toContainText('asking');
        await expect(row).toContainText('Waiting for your answer');
        await expect(row.locator('[data-agent-chat-delegation-glyph="needsInput"]')).toBeVisible();
        // Escalation is also inline only: still no sidebar attention and no notification source.
        await expectNoAttention(page, parent.id, childId);
        // The question is the user's to answer, so the child's sidebar row keeps the static amber mark until it is.
        await expect(
            page.locator(`[data-session-id="${childId}"] [data-attention-pending]`),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('delegated-escalated.png') });

        await selectSession(page, childId);
        const origin = session.locator('[data-agent-chat-delegation-origin="delegated"]');
        await expect(origin).toContainText('Waiting for your answer');
        const card = origin.locator('[data-delegation-question="escalated"]');
        await expect(card).toContainText(
            `${parent.title} did not answer, so it is yours to answer`,
        );
        await expect(card.getByRole('textbox', { name: 'Type your answer' })).toBeVisible();
        expect(await readQuestion(chat, questionId)).toMatchObject({
            state: 'open',
            isEscalated: true,
            escalationReason: 'grace_elapsed',
        });

        // Typing in the child takes it over instead.
        const message = session.getByRole('textbox', { name: 'Message' });
        await message.fill('I will handle this myself');
        await message.press('Enter');
        const takenOver = session.locator('[data-agent-chat-delegation-origin="taken-over"]');
        await expect(takenOver).toContainText('You took over this Session');
        await expect(session.locator('[data-delegation-question]')).toHaveCount(0);
        await expect
            .poll(async () => (await readQuestion(chat, questionId))?.state)
            .toBe('cancelled');
        expect(await readQuestion(chat, questionId)).toMatchObject({
            cancelReason: 'taken_over',
        });
        await page.screenshot({ path: testInfo.outputPath('delegated-question-taken-over.png') });
        await rm(join(chat.controlDirectory, HOLD_CHILD_FILE));
    } finally {
        await chat.cleanup();
    }
});

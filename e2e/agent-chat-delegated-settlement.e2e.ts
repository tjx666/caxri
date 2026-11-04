import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';

import { openAgentChat } from './support/agent-chat-fixture.ts';
import { selectSession } from './support/delegated-sessions-fixture.ts';
import type { DelegatingChat } from './support/delegating-chat-fixture.ts';
import {
    caxriCliCommand,
    CHILD_SUMMARY,
    CHILD_TITLE,
    createParentSession,
    DELEGATE_PROMPT,
    HOLD_CHILD_FILE,
    launchDelegatingChat,
    SETTLEMENT_NOTICE_REPLY,
} from './support/delegating-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { pageRequest, selectedSessionId, sessionCard, VISIBLE_SESSION } from './support/helpers.ts';

const WAIT_PROMPT = 'delegate the review and wait';
const SIBLING_PROMPT = 'open another Session for the release notes';
const HANDBACK_REPLY = 'Continued the handed-back Session.';
const WAITED_REPLY = 'Waited for the review myself.';
const SIBLING_REPLY = 'Started the sibling Session.';
const SIBLING_TITLE = 'Write the release notes';
const HOLD_PARENT_FILE = 'hold-parent';

/**
 * The newest delegation's ID, read from the profile by the shell the fake Agent runs: the script is written before any
 * task exists, so it cannot name an ID.
 */
function firstDelegationId(chat: DelegatingChat): string {
    return `"$(ls ${join(chat.userData, 'delegations')} | head -1)"`;
}

/**
 * Writes the scripted turns of this spec's parent Agent: delegate and end the turn, delegate and wait, start an
 * independent sibling, and the two notices (a settlement and a hand-back) it answers.
 */
async function writeSettlementScript(chat: DelegatingChat, projectId: string): Promise<void> {
    const followUpPath = join(chat.directory, 'follow-up.md');
    const siblingPath = join(chat.directory, 'sibling.md');
    await writeFile(followUpPath, 'Now tighten the retry design.');
    await writeFile(siblingPath, 'Write the release notes for this version.');
    const create = (requestId: string, title: string, flags: string, promptPath: string) =>
        caxriCliCommand(
            `agent delegate create --project ${projectId} --new-session --title "${title}" --provider codex ${flags} --prompt-file ${promptPath} --request-id ${requestId} --json`,
        );
    const childTurn = {
        prompt: 'Read the delegated task from ',
        isPrefix: true,
        steps: [
            { kind: 'hold', file: HOLD_CHILD_FILE },
            { kind: 'message', text: `Reviewed the retry design.\n\nSummary: ${CHILD_SUMMARY}` },
        ],
    };
    const waitCommand = caxriCliCommand(
        `agent delegate wait ${firstDelegationId(chat)} --timeout 120000 --json`,
    );
    const delegate = create('e2e-settle-review', CHILD_TITLE, '', chat.taskPath);
    await writeFile(
        chat.scriptPath,
        JSON.stringify({
            turns: [
                {
                    prompt: DELEGATE_PROMPT,
                    steps: [
                        { kind: 'command', command: delegate, output: '', shouldRun: true },
                        { kind: 'message', text: 'Delegated the review to a new Session.' },
                    ],
                },
                {
                    prompt: WAIT_PROMPT,
                    steps: [
                        { kind: 'command', command: delegate, output: '', shouldRun: true },
                        {
                            kind: 'command',
                            command: waitCommand,
                            output: '',
                            shouldRun: true,
                        },
                        { kind: 'message', text: WAITED_REPLY },
                    ],
                },
                {
                    prompt: SIBLING_PROMPT,
                    steps: [
                        {
                            kind: 'command',
                            command: create(
                                'e2e-sibling',
                                SIBLING_TITLE,
                                '--independent',
                                siblingPath,
                            ),
                            output: '',
                            shouldRun: true,
                        },
                        { kind: 'message', text: SIBLING_REPLY },
                    ],
                },
                childTurn,
                {
                    prompt: '[Caxri] Delegated task update',
                    isPrefix: true,
                    steps: [{ kind: 'message', text: SETTLEMENT_NOTICE_REPLY }],
                },
                {
                    prompt: '[Caxri] The user handed Session',
                    isPrefix: true,
                    steps: [
                        { kind: 'hold', file: HOLD_PARENT_FILE },
                        {
                            kind: 'command',
                            command: `sh ${followUpScriptPath(chat)}`,
                            output: '',
                            shouldRun: true,
                        },
                        { kind: 'message', text: HANDBACK_REPLY },
                    ],
                },
            ],
        }),
    );
}

function followUpOutputPath(chat: DelegatingChat): string {
    return join(chat.directory, 'follow-up.out');
}

function followUpScriptPath(chat: DelegatingChat): string {
    return join(chat.directory, 'follow-up.sh');
}

/**
 * Writes the shell script the parent's hand-back turn runs: a follow-up needs the child's Session, which only exists
 * once the delegation ran, so the spec fills it in before the hand-back.
 */
async function writeFollowUpScript(
    chat: DelegatingChat,
    projectId: string,
    childId: string,
): Promise<void> {
    await writeFile(
        followUpScriptPath(chat),
        `${caxriCliCommand(
            `agent delegate create --project ${projectId} --session ${childId} --provider codex --follow-up ${firstDelegationId(chat)} --prompt-file ${join(chat.directory, 'follow-up.md')} --request-id e2e-follow-up --json`,
        )} > ${followUpOutputPath(chat)} 2>&1\n`,
    );
}

async function sendToParent(chat: DelegatingChat, text: string): Promise<void> {
    const message = chat.running.page
        .locator(VISIBLE_SESSION)
        .getByRole('textbox', { name: 'Message' });
    await message.fill(text);
    await message.press('Enter');
}

/**
 * The parent's turn ends while its child is still running (the 45 minute case, shortened). When the child settles the
 * parent is told on its own: a notice turn appears without the user typing. A parent that is still waiting on the task
 * itself is not told twice.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a settled delegated task wakes the idle parent Chat, and an active wait suppresses the notice', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-settlement-');
    try {
        const { page } = chat.running;
        const { projectId } = await createParentSession(chat);
        await writeSettlementScript(chat, projectId);
        await writeFile(join(chat.controlDirectory, HOLD_CHILD_FILE), '');
        await openAgentChat(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);

        await sendToParent(chat, DELEGATE_PROMPT);
        const strip = session.getByRole('region', { name: 'Delegated Sessions' });
        await expect(strip.locator('[data-agent-chat-delegated-session]')).toHaveCount(1);
        await expect(session.getByText('Delegated the review to a new Session.')).toBeVisible();
        await expect(session.getByText(SETTLEMENT_NOTICE_REPLY)).toHaveCount(0);

        // Released after the parent's turn ended: the parent wakes itself and answers the notice.
        await rm(join(chat.controlDirectory, HOLD_CHILD_FILE));
        await expect(session.getByText(SETTLEMENT_NOTICE_REPLY)).toBeVisible({ timeout: 30_000 });
        await expect(session.getByText('[Caxri] Delegated task update:')).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('settlement-notice-turn.png') });
    } finally {
        await chat.cleanup();
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a delegated task the parent is waiting on produces no settlement notice turn', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-wait-');
    try {
        const { page } = chat.running;
        const { projectId } = await createParentSession(chat);
        await writeSettlementScript(chat, projectId);
        await writeFile(join(chat.controlDirectory, HOLD_CHILD_FILE), '');
        await openAgentChat(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);

        await sendToParent(chat, WAIT_PROMPT);
        const strip = session.getByRole('region', { name: 'Delegated Sessions' });
        await expect(strip.locator('[data-agent-chat-delegated-session]')).toHaveCount(1);
        await rm(join(chat.controlDirectory, HOLD_CHILD_FILE));
        await expect(session.getByText(WAITED_REPLY)).toBeVisible({ timeout: 30_000 });

        // The quiet window is 1.5 s; well past it, still no notice turn.
        await page.waitForTimeout(4000);
        await expect(session.getByText(SETTLEMENT_NOTICE_REPLY)).toHaveCount(0);
        await expect(session.getByText('[Caxri] Delegated task update:')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('settlement-wait-no-notice.png') });
    } finally {
        await chat.cleanup();
    }
});

/**
 * The user types in the child (a takeover), lets it go idle, and hands it back. The parent is told, and its follow-up
 * becomes a new task in the same Session and Chat, with the origin strip delegated again.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the user hands a taken-over Session back, the parent is told and its follow-up succeeds', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-handback-');
    try {
        const { page } = chat.running;
        const { projectId, sessionId: parentId } = await createParentSession(chat);
        const parent = (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
            (candidate) => candidate.id === parentId,
        )!;
        await writeSettlementScript(chat, projectId);
        await openAgentChat(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);

        await sendToParent(chat, DELEGATE_PROMPT);
        const strip = session.getByRole('region', { name: 'Delegated Sessions' });
        const row = strip.locator('[data-agent-chat-delegated-session]');
        await expect(row).toContainText(CHILD_SUMMARY);
        const childId = (await row.getAttribute('data-agent-chat-delegated-session'))!;
        // Let the settlement wake-up finish so the later notices are only the hand-back's.
        await expect(session.getByText(SETTLEMENT_NOTICE_REPLY)).toBeVisible({ timeout: 30_000 });

        await writeFollowUpScript(chat, projectId, childId);

        // Take over, and let the child answer: it is idle and under the user's control.
        await row.click();
        await expect.poll(() => selectedSessionId(page)).toBe(childId);
        const childMessage = session.getByRole('textbox', { name: 'Message' });
        await childMessage.fill('Let me check one thing');
        await childMessage.press('Enter');
        const takenOver = session.locator('[data-agent-chat-delegation-origin="taken-over"]');
        await expect(takenOver).toContainText('You took over this Session');
        await expect(session.getByText('You said: Let me check one thing')).toBeVisible();

        // A draft in the composer disables the hand-back and says why.
        const handBack = takenOver.getByRole('button', { name: `Hand back to ${parent.title}` });
        await expect(handBack).toBeVisible();
        await childMessage.fill('half-typed note');
        await expect(handBack).toHaveAttribute('aria-disabled', 'true');
        await expect(takenOver).toContainText('Send or clear the message you are typing');
        await page.screenshot({ path: testInfo.outputPath('handback-disabled-draft.png') });
        await childMessage.fill('');
        await expect(handBack).toHaveAttribute('aria-disabled', 'false');
        await page.screenshot({ path: testInfo.outputPath('handback-available.png') });

        // Hand back while the parent is held mid-turn: the pending line shows.
        await writeFile(join(chat.controlDirectory, HOLD_PARENT_FILE), '');
        await handBack.click();
        const pending = session.locator('[data-agent-chat-delegation-origin]');
        await expect(pending).toContainText(`Handed back to ${parent.title}`, {
            timeout: 30_000,
        });
        await expect(pending).toContainText('waiting for it to continue');
        await page.screenshot({ path: testInfo.outputPath('handback-pending.png') });

        // The parent continues: its follow-up is a new task in the same child Session.
        await rm(join(chat.controlDirectory, HOLD_PARENT_FILE));
        await selectSession(page, parentId);
        await expect(session.getByText(HANDBACK_REPLY)).toBeVisible({ timeout: 30_000 });
        /**
         * The follow-up was accepted as a new task in the same Session, not refused as a takeover.
         */
        const readOutput = async () =>
            existsSync(followUpOutputPath(chat)) ? readFile(followUpOutputPath(chat), 'utf8') : '';
        await expect.poll(readOutput).toContain('"followUpOf"');
        expect(await readOutput()).toContain(childId);
        await selectSession(page, childId);
        await expect(
            session.locator('[data-agent-chat-delegation-origin="delegated"]'),
        ).toContainText(`Delegated from ${parent.title}`);
        await page.screenshot({ path: testInfo.outputPath('handback-continued.png') });
    } finally {
        await chat.cleanup();
    }
});

/**
 * An Agent asked for another Session that it will not wait on: the Session is an ordinary top-level row that says where
 * it started, and the creator is never woken for it.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('an independent Session gets its own sidebar row and a Started from line, and wakes nobody', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-independent-');
    try {
        const { page } = chat.running;
        const { projectId, sessionId: parentId } = await createParentSession(chat);
        const parent = (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
            (candidate) => candidate.id === parentId,
        )!;
        await writeSettlementScript(chat, projectId);
        await openAgentChat(page, 'Codex Chat');
        const session = page.locator(VISIBLE_SESSION);

        await sendToParent(chat, SIBLING_PROMPT);
        await expect(session.getByText(SIBLING_REPLY)).toBeVisible();
        const siblingOf = async () =>
            (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
                (candidate) => candidate.title === SIBLING_TITLE,
            )?.id;
        await expect.poll(siblingOf).toBeTruthy();
        const siblingId = (await siblingOf())!;

        // An ordinary row at the parent's own level, not nested under it, and not on the parent's strip.
        const row = sessionCard(page, siblingId);
        await expect(row).toBeVisible();
        await expect(row).toHaveAttribute(
            'aria-level',
            (await sessionCard(page, parentId).getAttribute('aria-level'))!,
        );
        await expect(session.getByRole('region', { name: 'Delegated Sessions' })).toHaveCount(0);

        // The sibling carries its origin line and a way back, and no delegation copy.
        await row.click();
        await expect.poll(() => selectedSessionId(page)).toBe(siblingId);
        const origin = session.locator('[data-agent-chat-independent-origin]');
        await expect(origin).toContainText(`Started from ${parent.title}`);
        await expect(session.locator('[data-agent-chat-delegated-task]').first()).toContainText(
            'Started by',
        );
        await expect(origin.getByRole('button', { name: `Back to ${parent.title}` })).toBeVisible();
        await expect(session.locator('[data-agent-chat-delegation-origin]')).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('independent-origin.png') });

        // The creator is not woken when the sibling settles.
        await expect(session.getByText(CHILD_SUMMARY).first()).toBeVisible();
        await selectSession(page, parentId);
        await page.waitForTimeout(4000);
        await expect(session.getByText('[Caxri] Delegated task update:')).toHaveCount(0);
    } finally {
        await chat.cleanup();
    }
});

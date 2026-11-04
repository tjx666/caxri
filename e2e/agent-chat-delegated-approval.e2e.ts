import { readdir, readFile, writeFile } from 'node:fs/promises';
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
    launchDelegatingChat,
} from './support/delegating-chat-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { pageRequest, VISIBLE_SESSION } from './support/helpers.ts';

const APPROVE_PROMPT = 'decide the request';
/**
 * The command the delegated Agent asks permission to run. It must never reach a log.
 */
const CHILD_COMMAND = 'echo child-needs-approval';
const NOTICE = 'The Agent that delegated this answered the request.';

/**
 * Replaces the fixture's script. The delegated child asks permission for `CHILD_COMMAND` and then reports. The parent
 * delegates in its first turn, and decides the child's request in a second turn only when the spec sends
 * `APPROVE_PROMPT`: the real CLI runs from the parent's own commands, so the Server sees the delegating Agent as the
 * caller. The dynamic IDs travel through files in the control directory.
 */
async function writeApprovalScript(chat: DelegatingChat, projectId: string, decision: string) {
    const cli = [process.execPath, join(import.meta.dirname, '..', 'apps/cli/dist/caxri.cjs')].join(
        ' ',
    );
    const createFile = join(chat.controlDirectory, 'create.json');
    const statusFile = join(chat.controlDirectory, 'status.json');
    const approveFile = join(chat.controlDirectory, 'approve.json');
    const identifier = (file: string, key: string) =>
        String.raw`$(sed -n 's/.*"${key}": *"\([^"]*\)".*/\1/p' ${file} | head -1)`;
    const create = [
        cli,
        'agent delegate create',
        `--project ${projectId} --new-session --title "${CHILD_TITLE}"`,
        `--provider codex --prompt-file ${chat.taskPath} --request-id e2e-delegated-approval --json > ${createFile}`,
    ].join(' ');
    const delegationId = identifier(createFile, 'delegationId');
    const status = `${cli} agent delegate status ${delegationId} --json > ${statusFile}`;
    const approve = `${cli} agent delegate approve ${delegationId} ${identifier(statusFile, 'requestId')} --revision ${identifier(statusFile, 'revision')} ${decision} --json > ${approveFile} 2>&1`;
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
                        {
                            kind: 'approval',
                            command: CHILD_COMMAND,
                            output: 'child-needs-approval',
                        },
                        {
                            kind: 'message',
                            text: `Reviewed the retry design.\n\nSummary: ${CHILD_SUMMARY}`,
                        },
                    ],
                },
                {
                    prompt: APPROVE_PROMPT,
                    steps: [
                        { kind: 'command', command: status, output: '', shouldRun: true },
                        { kind: 'command', command: approve, output: '', shouldRun: true },
                        { kind: 'message', text: 'Decided the request.' },
                    ],
                },
            ],
        }),
    );
}

/**
 * Delegates through the parent Chat. The child's turn stops at its permission request, so the request stays pending for
 * as long as the spec needs.
 */
async function delegateAndRequest(chat: DelegatingChat, decision = '--accept') {
    const { page } = chat.running;
    const { projectId, sessionId: parentId } = await createParentSession(chat);
    const parent = (await pageRequest<BootstrapState>(page, 'app.bootstrap')).sessions.find(
        (session) => session.id === parentId,
    )!;
    await writeApprovalScript(chat, projectId, decision);
    await openAgentChat(page, 'Codex Chat');
    const session = page.locator(VISIBLE_SESSION);
    return { page, parent, parentId, projectId, session };
}

async function sendToParent(
    session: ReturnType<DelegatingChat['running']['page']['locator']>,
    text: string,
) {
    const message = session.getByRole('textbox', { name: 'Message' });
    await message.fill(text);
    await message.press('Enter');
}

/**
 * Whether the stored Session carries the `waiting` attention kind, the source of every needs-input notification and of
 * the sidebar's amber glyph.
 */
async function hasWaitingAttention(page: Parameters<typeof pageRequest>[0], sessionId: string) {
    const { sessions } = await pageRequest<BootstrapState>(page, 'app.bootstrap');
    return sessions.find((session) => session.id === sessionId)?.lastAttentionKind === 'waiting';
}

/**
 * Every file under the profile's log directory, concatenated.
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

async function readWhenWritten(path: string): Promise<string> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
    }
}

/**
 * A covered request is held quietly for the delegating Agent, which then accepts it through the CLI; the child runs on.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('the delegating Agent approves a covered request while it is held quietly', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-approve-');
    try {
        const { page, parent, session } = await delegateAndRequest(chat);
        await sendToParent(session, DELEGATE_PROMPT);
        const strip = session.getByRole('region', { name: 'Delegated Sessions' });
        const row = strip.locator('[data-agent-chat-delegated-session]');
        await expect(row).toContainText(CHILD_TITLE);
        const childId = (await row.getAttribute('data-agent-chat-delegated-session'))!;

        // Held for the delegating Agent: muted asking glyph, no amber, no attention for anyone.
        await expect(row).toContainText('Waiting for the Agent that delegated it to approve');
        await expect(row.locator('[data-agent-chat-delegation-glyph="asking"]')).toBeVisible();
        await expect(
            session.locator('[data-agent-chat-delegation-glyph="needsInput"]'),
        ).toHaveCount(0);
        await expect(strip).not.toContainText('waiting for your approval');
        expect(await hasWaitingAttention(page, childId)).toBe(false);
        expect(await hasWaitingAttention(page, parent.id)).toBe(false);
        await expect(
            page.locator(`[data-session-id="${childId}"] [data-session-status="attention"]`),
        ).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath('approval-held.png') });

        // The parent accepts from its own turn; the child runs the command and finishes.
        await sendToParent(session, APPROVE_PROMPT);
        await expect
            .poll(() => readWhenWritten(join(chat.controlDirectory, 'approve.json')))
            .toContain('approved');
        await expect(row).toContainText(CHILD_SUMMARY);

        await selectSession(page, childId);
        await expect(session.getByText(NOTICE)).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('approval-decided.png') });

        // The command text never reaches a log.
        expect(await readLogs(chat.userData)).not.toContain(CHILD_COMMAND);
    } finally {
        await chat.cleanup();
    }
});

/**
 * A request the parent's permission does not cover is the user's at once: amber, with the reason on the card. Reading
 * the Session does not clear it; only answering does.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('an uncovered request is amber at once and stays amber until the user answers', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-uncovered-');
    try {
        const { page, parent, session } = await delegateAndRequest(chat);
        const picker = session
            .getByRole('button', { name: /^Permissions: / })
            .filter({ visible: true });
        await picker.click();
        await page.getByRole('menuitemradio', { name: /Read only/ }).click();
        await expect(picker).toHaveAccessibleName('Permissions: Read only');
        await sendToParent(session, DELEGATE_PROMPT);
        const strip = session.getByRole('region', { name: 'Delegated Sessions' });
        const row = strip.locator('[data-agent-chat-delegated-session]');
        await expect(row).toContainText(CHILD_TITLE);
        const childId = (await row.getAttribute('data-agent-chat-delegated-session'))!;

        await expect(strip).toContainText('1 waiting for your approval');
        await expect(row).toContainText('Waiting for your approval');
        await expect(row.locator('[data-agent-chat-delegation-glyph="needsInput"]')).toBeVisible();
        const glyph = page.locator(
            `[data-session-id="${childId}"] [data-session-status="attention"]`,
        );
        await expect(glyph).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('approval-uncovered.png') });

        // Viewing the child shows the reason, and the glyph stays after the Session was read.
        await selectSession(page, childId);
        const note = session.locator('[data-agent-chat-delegation-approval-note]');
        await expect(note).toBeVisible();
        await expect(note).not.toContainText(CHILD_COMMAND);
        await page.screenshot({ path: testInfo.outputPath('approval-uncovered-card.png') });
        await selectSession(page, parent.id);
        await expect(glyph).toHaveAttribute('data-attention-pending', '');

        // The user answers; the child finishes and the glyph clears.
        await selectSession(page, childId);
        await session.getByRole('button', { name: 'Run', exact: true }).click();
        await expect(note).toHaveCount(0);
        await expect(glyph).toHaveCount(0);
        await expect(session.getByText(CHILD_SUMMARY)).toBeVisible();
    } finally {
        await chat.cleanup();
    }
});

/**
 * A covered request the parent leaves alone becomes the user's after the grace, which the E2E shortens to seconds.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('a covered request the delegating Agent leaves alone escalates to the user', async ({}, testInfo) => {
    const chat = await launchDelegatingChat('caxri-delegated-escalate-', {
        env: { CAXRI_E2E_APPROVAL_GRACE_MS: '6000' },
    });
    try {
        const { page, session } = await delegateAndRequest(chat);
        await sendToParent(session, DELEGATE_PROMPT);
        const strip = session.getByRole('region', { name: 'Delegated Sessions' });
        const row = strip.locator('[data-agent-chat-delegated-session]');
        await expect(row).toContainText(CHILD_TITLE);
        const childId = (await row.getAttribute('data-agent-chat-delegated-session'))!;

        await expect(strip).toContainText('1 asking');
        await expect(strip).toContainText('1 waiting for your approval', { timeout: 30_000 });
        await expect(row).toContainText('Waiting for your approval');
        expect(await hasWaitingAttention(page, childId)).toBe(true);
        await expect(
            page.locator(`[data-session-id="${childId}"] [data-session-status="attention"]`),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath('approval-escalated.png') });
    } finally {
        await chat.cleanup();
    }
});

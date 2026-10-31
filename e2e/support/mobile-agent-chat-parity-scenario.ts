import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BootstrapState } from '@caxri/protocol';
import { agentChatTextWithPathReferences } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    agentText,
    checkBounds,
    scrollTimelineTo,
    scrollTimelineUntil,
    waitForCheck,
    waitForNoCheck,
} from './mobile-agent-chat-helpers';
import {
    adbShell,
    mobileDisplayState,
    mobileNativeControlBounds,
    mobileSemantics,
    observeMobileNode,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';

/**
 * The cited file every case seeds, with enough lines that the viewer's cited line is not the first one.
 */
const CITED_FILE = 'src/app.ts';
const CITED_FILE_LINES = [
    'export const first = 1;',
    'export const second = first + 1;',
    'export const third = second + 1;',
];

/**
 * The `table` reply's first paragraph as one Android text view: its `[app.ts](src/app.ts:2)` link leads the line.
 */
const TABLE_SUMMARY_LINE = 'Updated app.ts and src/app.ts#L1-L2; see the plan below.';

/**
 * Where the `app.ts` link sits on that line, in dp from its left edge: past "Updated " (about 62 dp at the reply's 16
 * dp body type) and inside the six-character name.
 */
const SUMMARY_LINK_OFFSET_DP = 82;

/**
 * The reply body's line height in dp (`ConversationMarkdown`'s `body.lineHeight`).
 */
const REPLY_LINE_HEIGHT_DP = 23;

const seedCitedFile = async (root: string) => {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, CITED_FILE), `${CITED_FILE_LINES.join('\n')}\n`);
};

/**
 * Pairs a Codex Chat fixture whose Project holds {@link CITED_FILE}, and opens the Chat on the phone.
 */
async function openChat(environment: MobileAgentScenarioEnvironment) {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'agent-chat',
        seedProject: seedCitedFile,
        serial: environment.serial,
        // As the real CLI does, so `@` can cite this Chat's conversation from another Session.
        shouldWriteCodexRollouts: true,
    });
    const chat = fixture.agentChat;
    if (!chat || !fixture.allowedSessionId) {
        await fixture.stop();
        throw new Error('Chat fixture is unavailable');
    }
    return { chat, fixture, sessionId: fixture.allowedSessionId };
}

/**
 * Waits until the one native text view reading `text` is laid out, and returns its bounds.
 */
async function waitForText(serial: string, text: string) {
    try {
        const bounds = await waitForMobile(
            () => mobileNativeControlBounds(serial, { className: 'android.widget.TextView', text }),
            (candidate) => candidate !== null,
            15_000,
        );
        if (bounds) return bounds;
    } catch {
        // Name the missing text below instead of the generic timeout.
    }
    throw new Error(`${JSON.stringify(text)} is not on screen`);
}

/**
 * Waits for a menu group heading. The heading is styled `textTransform: 'uppercase'`, which React Native applies to the
 * native text on Android, so either casing counts. Its `header` role gives the native node another class than a plain
 * text view, so only the text identifies it.
 */
async function waitForHeading(serial: string, label: string) {
    try {
        const bounds = await waitForMobile(
            async () =>
                (await mobileNativeControlBounds(serial, { text: label.toUpperCase() })) ??
                mobileNativeControlBounds(serial, { text: label }),
            (candidate) => candidate !== null,
            15_000,
        );
        if (bounds) return bounds;
    } catch {
        // Name the missing heading below instead of the generic timeout.
    }
    throw new Error(`The ${JSON.stringify(label)} heading is not on screen`);
}

/**
 * Proves the viewer shows {@link CITED_FILE}: its Project path under the title and every line of its content.
 */
async function expectCitedFileShown(serial: string): Promise<void> {
    await waitForCheck(serial, 'file-viewer-lines');
    const path = await observeMobileNode(serial, 'file-viewer-path', {
        kind: 'equals',
        value: CITED_FILE,
    });
    if (!path.exists || !path.textMatches) throw new Error('The viewer names another file');
    // eslint-disable-next-line no-await-in-loop -- One UIAutomator dump at a time; parallel dumps share the device file.
    for (const line of CITED_FILE_LINES) await waitForText(serial, line);
}

/**
 * Sends the `table` turn, whose user message carries `references` and whose reply links {@link CITED_FILE}'s line 2.
 */
async function sendTableTurn(
    chat: Awaited<ReturnType<typeof openChat>>['chat'],
    references: Array<{ isDirectory: boolean; path: string }> = [],
): Promise<void> {
    await chat.send({ text: agentChatTextWithPathReferences('table', references, 'Codex') });
    await waitForMobile(
        () => chat.read(),
        (snapshot) => agentText(snapshot).includes('| Option | Cost |') && !snapshot.activeTurnId,
    );
}

/**
 * `MOB-CHAT-FILE-CHIP-01`: a file the user attached shows as a chip under their message, and a tap opens its content in
 * the file viewer.
 */
export async function executeMobileChatFileChipScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const { chat, fixture, sessionId } = await openChat(environment);
    try {
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        const root = join(fixture.testDirectory, 'allowed-project');
        await sendTableTurn(chat, [{ isDirectory: false, path: join(root, CITED_FILE) }]);
        await waitForNoCheck(serial, 'agent-chat-activity');
        // The long reply leaves the timeline at its end, with the user's message and its chip above the screen.
        await scrollTimelineTo(serial, 'agent-chat-path-chip');
        await capture(environment, 'conversation', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-chat-path-chip');
        await expectCitedFileShown(serial);
        await capture(environment, 'file', artifacts);

        await finish(environment, artifacts, { chip: 'opened-file-content', status: 'passed' });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-FILE-LINK-01`: a file link in the Agent's reply opens the file viewer with the cited line highlighted. The
 * link is a span inside its paragraph, which Android does not expose as its own node, so the tap lands on its measured
 * place in the line; the viewer's path and cited line then prove what it opened.
 */
export async function executeMobileChatFileLinkScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const { chat, fixture, sessionId } = await openChat(environment);
    try {
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await sendTableTurn(chat);
        await waitForNoCheck(serial, 'agent-chat-activity');
        /**
         * The reply's first paragraph sits above the screen once the long reply has streamed in. Android clips a
         * paragraph's bounds at the timeline's top edge, so one that starts exactly there may hide its first line;
         * scroll until it starts below that edge.
         */
        await scrollTimelineUntil(serial, async () => {
            const frame = checkBounds(await mobileSemantics(serial), 'conversation-view');
            const line = await mobileNativeControlBounds(serial, {
                className: 'android.widget.TextView',
                text: TABLE_SUMMARY_LINE,
            });
            return frame !== undefined && line !== null && line.top > frame.top;
        });
        const summary = await waitForText(serial, TABLE_SUMMARY_LINE);
        await capture(environment, 'reply', artifacts);

        const display = await mobileDisplayState(serial);
        const scale =
            ((display.density.override ?? display.density.physical) / 160) * display.fontScale;
        await adbShell(serial, [
            'input',
            'tap',
            String(Math.round(summary.left + SUMMARY_LINK_OFFSET_DP * scale)),
            String(Math.round(summary.top + (REPLY_LINE_HEIGHT_DP * scale) / 2)),
        ]);
        await expectCitedFileShown(serial);
        const cited = checkBounds(await mobileSemantics(serial), 'file-viewer-cited-line');
        const second = await waitForText(serial, CITED_FILE_LINES[1]);
        const middle = (second.top + second.bottom) / 2;
        if (!cited || middle < cited.top || middle > cited.bottom)
            throw new Error('The highlighted line is not line 2');
        await capture(environment, 'cited-line', artifacts);

        await finish(environment, artifacts, {
            citedLine: 2,
            replyLink: 'opened-at-cited-line',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * The rows `/` leads with for a Codex Chat the device controls, as `mobileAgentChatBuiltInActions` words them. The menu
 * shows about six row heights, and its heading and descriptions take part of that, so only these fit unscrolled.
 */
const SLASH_ROWS = ['/new-session [next task]', '/model', '/rename'];

/**
 * The Session commands below the fold, each reached by narrowing the menu as a user would.
 */
const SLASH_FILTERED_ROWS = [
    { query: 'ar', row: '/archive' },
    { query: 'pi', row: '/pin' },
];

/**
 * `MOB-CHAT-SLASH-01`: `/` lists Caxri's own commands ahead of the provider's, as Desktop does, and `/rename` opens the
 * Session's Rename sheet.
 */
export async function executeMobileChatSlashScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const { fixture, sessionId } = await openChat(environment);
    try {
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${sessionId}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
        await adbShell(serial, ['input', 'text', '/']);
        await waitForCheck(serial, 'agent-chat-command-list');
        const rows: Array<Awaited<ReturnType<typeof waitForText>>> = [];
        // eslint-disable-next-line no-await-in-loop -- One UIAutomator dump at a time; parallel dumps share the device file.
        for (const row of SLASH_ROWS) rows.push(await waitForText(serial, row));
        // The rows read top to bottom in Desktop's order, `/new-session` first.
        if (rows.some((row, index) => index > 0 && row.top <= rows[index - 1].top))
            throw new Error('The app commands are out of order');
        await capture(environment, 'menu', artifacts);
        for (const { query, row } of SLASH_FILTERED_ROWS) {
            // eslint-disable-next-line no-await-in-loop -- One draft and one UIAutomator dump at a time.
            await adbShell(serial, ['input', 'text', query]);
            // eslint-disable-next-line no-await-in-loop -- see above.
            await waitForText(serial, row);
            // eslint-disable-next-line no-await-in-loop -- see above.
            await adbShell(serial, [
                'input',
                'keyevent',
                ...Array.from(query, () => 'KEYCODE_DEL'),
            ]);
        }

        await adbShell(serial, ['input', 'text', 'ren']);
        await waitForText(serial, '/rename');
        await capture(environment, 'filtered', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-command-0');
        await waitForCheck(serial, 'session-rename-input');
        await capture(environment, 'rename-sheet', artifacts);
        await tapMobileCheckByBounds(serial, 'session-rename-cancel');
        await waitForNoCheck(serial, 'session-rename-input');
        // UIAutomator reports an empty EditText's placeholder as its text, so look for the command instead of ''.
        const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'includes',
            value: '/ren',
        });
        if (!draft.exists || draft.textMatches) throw new Error('/rename left its draft behind');

        await finish(environment, artifacts, {
            menu: 'app-commands-listed-in-order',
            rename: 'sheet-opened',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * The title the open, citing Chat carries, so the cited Chat's title reads only in its `@` row.
 */
const CITING_SESSION_TITLE = 'Pricing table review';

/**
 * Pairs a Chat fixture whose first Chat has a finished turn, then opens a second Chat on the phone, so the first is the
 * one other Session `@` offers. Returns the first Chat's title, which the citing sentence quotes.
 */
async function openCitingChat(environment: MobileAgentScenarioEnvironment) {
    const { chat, fixture, sessionId } = await openChat(environment);
    const { serial } = environment;
    try {
        // The phone is not paired yet, so only the Host's snapshot can tell the turn finished.
        await sendTableTurn(chat);
        const { page } = fixture.running;
        const citing = await pageRequest<{ session: { id: string } }>(page, 'session.create', {
            defaultAgent: 'codex',
            projectId: fixture.allowedProjectId,
            surface: 'chat',
        });
        // The citing Chat has no Codex thread yet, so the rename stays on the Host.
        await pageRequest(page, 'session.rename', {
            sessionId: citing.session.id,
            title: CITING_SESSION_TITLE,
        });
        /**
         * The cited Chat keeps whatever title the Host gave it: renaming it after its turn would ask the fake Codex
         * app-server for `thread/name/set`, which it does not implement.
         */
        const { sessions } = await pageRequest<BootstrapState>(page, 'app.bootstrap');
        const title = sessions.find((session) => session.id === sessionId)?.title;
        if (!title || title === CITING_SESSION_TITLE)
            throw new Error('The cited Chat has no distinct title');
        await fixture.pair();
        await tapMobileCheck(serial, `session-row-${citing.session.id}`);
        await waitForCheck(serial, 'agent-chat-status-empty');
        await tapMobileCheckByBounds(serial, 'agent-chat-composer-input');
        return { fixture, title };
    } catch (error) {
        await fixture.stop();
        throw error;
    }
}

/**
 * `MOB-CHAT-MENTION-FILE-01`: `@` with a typed name lists the Project's matching files under a Files heading, as
 * Desktop does, and choosing one inserts its `@path` mention.
 */
export async function executeMobileChatMentionFileScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const { fixture } = await openCitingChat(environment);
    try {
        await adbShell(serial, ['input', 'text', '@app']);
        const heading = await waitForHeading(serial, 'Files');
        const name = await waitForText(serial, 'app.ts');
        await waitForText(serial, 'src');
        if (name.top <= heading.top) throw new Error('The file is not under the Files heading');
        await capture(environment, 'files', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-mention-0');
        const draft = await observeMobileNode(serial, 'agent-chat-composer-input', {
            kind: 'equals',
            value: `@${CITED_FILE} `,
        });
        if (!draft.exists || !draft.textMatches)
            throw new Error('The file mention was not inserted');
        await waitForNoCheck(serial, 'agent-chat-mention-list');
        await capture(environment, 'inserted', artifacts);

        await finish(environment, artifacts, { file: 'mention-inserted', status: 'passed' });
    } finally {
        await fixture.stop();
    }
}

/**
 * `MOB-CHAT-MENTION-SESSION-01`: a bare `@` lists the Host's other Sessions under a Sessions heading (files need a
 * typed name), and choosing one inserts the sentence citing that Session's conversation.
 */
export async function executeMobileChatMentionSessionScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const { fixture, title } = await openCitingChat(environment);
    try {
        await adbShell(serial, ['input', 'text', '@']);
        const heading = await waitForHeading(serial, 'Sessions');
        const row = await waitForText(serial, title);
        if (row.top <= heading.top)
            throw new Error('The Session is not under the Sessions heading');
        await capture(environment, 'sessions', artifacts);
        await tapMobileCheckByBounds(serial, 'agent-chat-mention-0');
        const sentence = `contains the conversation from Session ${JSON.stringify(title)}.`;
        await waitForMobile(
            () =>
                observeMobileNode(serial, 'agent-chat-composer-input', {
                    kind: 'includes',
                    value: sentence,
                }),
            (draft) => draft.exists && draft.textMatches === true,
            30_000,
        );
        await waitForNoCheck(serial, 'agent-chat-mention-list');
        // The inserted path is the Host's temporary reference file, so clear it before the final screenshot.
        await adbShell(serial, [
            'input',
            'keyevent',
            'KEYCODE_MOVE_END',
            ...Array.from({ length: 200 }, () => 'KEYCODE_DEL'),
        ]);
        await waitForMobile(
            () =>
                observeMobileNode(serial, 'agent-chat-composer-input', {
                    kind: 'includes',
                    value: sentence,
                }),
            (draft) => draft.exists && draft.textMatches === false,
            10_000,
        );

        await finish(environment, artifacts, {
            draft: 'cited-session-title-then-cleared',
            menu: 'closed-after-choice',
            session: 'reference-inserted',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentChatSnapshot } from '@caxri/protocol';
import { draculaTheme } from '@caxri/protocol';

import type { FakeClaudeScript } from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    adbShell,
    androidBounds,
    copyMobileFramebufferRecording,
    mobileColorBounds,
    mobileSemantics,
    startMobileFramebufferRecording,
    waitForMobile,
} from './mobile-android';
import { departuresFromFinalPicture, readRecordingBand } from './mobile-motion-analysis';

const EARLIER_PROMPT = 'Review the branch';
const PROMPT = 'Merge the pull request';
const HOLD_FILE = 'between-calls';

/**
 * A finished turn above the running one, so the rows above the latest turn hold earlier content that a scroll jump
 * would bring into view.
 */
const EARLIER_REPLY = Array.from(
    { length: 24 },
    (_, index) => `${index + 1}. The branch keeps change ${index + 1} focused and tested.`,
).join('\n');

const bash = (command: string) => ({
    kind: 'tool' as const,
    name: 'Bash',
    input: { command },
    output: '',
    durationMs: 100,
});

/**
 * The second turn finishes several quick calls and then waits for the model's next step, as a turn does while the Agent
 * thinks between tool calls: its work summary stays open and marked running with no call in flight.
 */
const script: FakeClaudeScript = {
    turns: [
        {
            prompt: EARLIER_PROMPT,
            steps: [
                bash('git status'),
                bash('git diff --stat'),
                { kind: 'text', text: EARLIER_REPLY },
            ],
        },
        {
            prompt: PROMPT,
            steps: [
                bash('git status --short'),
                bash('git log -1'),
                bash('git fetch'),
                bash('git branch -vv'),
                { kind: 'hold', file: HOLD_FILE },
                { kind: 'text', text: 'Merged.' },
            ],
        },
    ],
};

const isBetweenCalls = (snapshot: AgentChatSnapshot): boolean => {
    const commands = snapshot.items.filter((item) => item.type === 'command');
    return (
        Boolean(snapshot.activeTurnId) &&
        commands.length === 6 &&
        commands.every((item) => item.status !== 'running')
    );
};

/**
 * The Chat timeline on the 1080x2400 emulator, below the Session tabs and above the composer's activity line. The work
 * summary's card is the only thing inside it drawn in the theme's border color.
 */
const TIMELINE_REGION = { bottom: 1550, left: 0, right: 1080, top: 680 };

/**
 * A running turn's spinner and elapsed clock keep the screen changing, so UIAutomator never idles and cannot read the
 * open Chat; the card is found by its border pixels instead.
 */
const cardBounds = (serial: string) =>
    mobileColorBounds(serial, TIMELINE_REGION, draculaTheme.colors.border, 4);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long the fold is filmed after the tap. The flash lasted one frame on a phone.
 */
const WATCH_MS = 2500;

/**
 * `MOB-CHAT-WORK-GROUP-FOLD-01`: folding an expanded work summary in the latest turn shrank the rows under the turn
 * spacer, and Android clamped the scroll before the spacer grew back, so the previous turn's reply flashed into view
 * for a frame. The running summary's title sweeps while folded, so the judged band is the user's message above the
 * card: it must hold still from the tap until the end of the recording.
 */
export async function executeMobileChatWorkGroupFoldScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath)
        throw new Error('MOB-CHAT-WORK-GROUP-FOLD-01 judges the fold from its recording');
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        claudeScript: script,
        mode: 'agent-chat',
        serial,
    });
    const holdPath = join(fixture.testDirectory, HOLD_FILE);
    await writeFile(holdPath, '');
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await fixture.pair();
        // With live motion a running turn keeps the Sessions list animating, so the row is found before the turns start.
        const row = (await mobileSemantics(serial)).find(
            ({ checkId }) => checkId === `session-row-${fixture.allowedSessionId}`,
        );
        const rowBounds = row && androidBounds(row.bounds);
        if (!rowBounds) throw new Error('The Session row is not laid out');
        await chat.send({ text: EARLIER_PROMPT });
        await waitForMobile(
            () => chat.read(),
            (snapshot) => !snapshot.activeTurnId && snapshot.turns.length === 1,
            60_000,
        );
        await chat.send({ text: PROMPT });
        await waitForMobile(() => chat.read(), isBetweenCalls, 60_000);
        await adbShell(serial, [
            'input',
            'tap',
            String(Math.floor((rowBounds.left + rowBounds.right) / 2)),
            String(Math.floor((rowBounds.top + rowBounds.bottom) / 2)),
        ]);
        const card = await waitForMobile(() => cardBounds(serial), Boolean, 30_000);
        if (!card) throw new Error('The work summary card is not drawn');
        await pause(1000);
        const header = {
            x: String(Math.floor((card.left + card.right) / 2)),
            y: String(Math.floor((card.top + card.bottom) / 2)),
        };
        await adbShell(serial, ['input', 'tap', header.x, header.y]);
        await pause(1500);
        const expanded = await cardBounds(serial);
        if (!expanded || expanded.bottom - expanded.top <= (card.bottom - card.top) * 2)
            throw new Error('The work summary did not expand');
        await capture(environment, 'expanded', artifacts);

        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await pause(500);
        await adbShell(serial, ['input', 'tap', header.x, header.y]);
        await pause(WATCH_MS);
        await recording.stop();
        recording = undefined;
        await capture(environment, 'folded', artifacts);
        const analysis = await mkdtemp(join(tmpdir(), 'caxri-work-group-fold-'));
        try {
            const video = join(analysis, 'fold.mp4');
            await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
            // The user's message sits just above the card; a scroll jump moves it or the reply above into this band.
            const { frames } = await readRecordingBand(video, {
                bottom: card.top - 8,
                top: card.top - 200,
            });
            const { departures } = departuresFromFinalPicture(frames);
            await finish(environment, artifacts, {
                departures,
                frames: frames.length,
                motion: 'live',
                status: departures === 0 ? 'passed' : 'failed',
            });
            if (departures > 0)
                throw new Error(
                    `Folding the work summary moved the turn above it in ${departures} frames`,
                );
        } finally {
            await rm(analysis, { force: true, recursive: true });
        }
    } finally {
        await recording?.stop();
        await rm(holdPath, { force: true });
        await fixture.stop();
    }
}

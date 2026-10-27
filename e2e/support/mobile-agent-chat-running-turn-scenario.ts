import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentChatSnapshot } from '@caxri/protocol';

import type {
    FakeClaudeScript,
    FakeClaudeScriptStep,
} from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-claude-script.ts';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import {
    adbShell,
    androidBounds,
    copyMobileFramebufferRecording,
    mobileDisplayState,
    mobileSemantics,
    startMobileFramebufferRecording,
    waitForMobile,
} from './mobile-android';
import { departuresFromFinalPicture, readRecordingBand } from './mobile-motion-analysis';

const RUNNING_PROMPT = 'Find why the plan usage drains so fast';
const LAST_NARRATION = 'Rewriting the Desktop side to read the dismissal.';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long the opened Chat is filmed. The shaking lasted about a second on the emulator.
 */
const WATCH_MS = 5_000;

/**
 * A search whose output fills most of a mobile field, so the phone's small window holds only a few of them and a
 * history page brings about twenty items.
 */
const search = (index: number): FakeClaudeScriptStep => ({
    kind: 'tool',
    name: 'Bash',
    input: {
        command: `rg -n "usage" src/module-${index}.ts`,
        description: `Search module ${index}`,
    },
    output: Array.from(
        { length: 60 },
        (_, line) => `src/module-${index}.ts:${line}: const usage = readUsage(plan, window);`,
    ).join('\n'),
    durationMs: 40,
});

/**
 * A long Claude turn shaped like a real investigation: rounds of searches between short narrations, ending in a command
 * that keeps running, so the turn is still live when the phone opens it and its window starts deep inside the turn.
 */
const script: FakeClaudeScript = {
    turns: [
        {
            prompt: RUNNING_PROMPT,
            steps: [
                { kind: 'thinking', text: 'Looking at how usage is counted.' },
                ...Array.from({ length: 30 }, (_, round): FakeClaudeScriptStep[] => [
                    ...Array.from({ length: 3 + (round % 5) }, (_, index) =>
                        search(round * 20 + index),
                    ),
                    {
                        kind: 'text',
                        text:
                            round % 3 === 0
                                ? 'I am extending the existing Android plan-limits scenario to relaunch the app after dismissing, then confirm the reminder stays hidden.'
                                : `Step ${round}: now the protocol edits.`,
                    },
                ]).flat(),
                { kind: 'text', text: LAST_NARRATION },
                {
                    kind: 'tool',
                    name: 'Bash',
                    input: { command: 'sleep 900', description: 'Declare lanes and recheck' },
                    output: 'done',
                    durationMs: 900_000,
                },
            ],
        },
    ],
};

const isRunningLastCommand = (snapshot: AgentChatSnapshot): boolean =>
    Boolean(snapshot.activeTurnId) &&
    snapshot.items.some((item) => item.type === 'agentMessage' && item.text === LAST_NARRATION);

/**
 * `MOB-CHAT-RUNNING-OPEN-01`: a Chat whose running turn is long enough that its window starts deep inside that turn
 * opens and holds still. The phone used to fill the short window with ten history pages in a row, each shifting the
 * rows before the list returned to its end, so the timeline shook for a second after opening.
 *
 * UIAutomator never reads a screen that keeps animating, and a screenshot every half second misses a one-second shake,
 * so the timeline is judged from every recorded frame: once its final picture first appears, it must never leave it.
 */
export async function executeMobileChatRunningTurnScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath)
        throw new Error('MOB-CHAT-RUNNING-OPEN-01 judges the opened Chat from its recording');
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        claudeScript: script,
        mode: 'agent-chat',
        serial,
    });
    let recording: Awaited<ReturnType<typeof startMobileFramebufferRecording>> | undefined;
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        // A running turn keeps the Sessions list animating, so the phone pairs and finds the Session's row first.
        await fixture.pair();
        const row = (await mobileSemantics(serial)).find(
            ({ checkId }) => checkId === `session-row-${fixture.allowedSessionId}`,
        );
        const bounds = row && androidBounds(row.bounds);
        if (!bounds) throw new Error('The Session row is not laid out');
        const { size } = await mobileDisplayState(serial);
        const { height } = size.override ?? size.physical;
        // The rows between the Chat's tabs and the running status line, which carries a ticking timer.
        const timeline = { top: Math.floor(height * 0.2), bottom: Math.floor(height * 0.55) };
        await chat.send({ text: RUNNING_PROMPT });
        await waitForMobile(() => chat.read(), isRunningLastCommand, 60_000);
        recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
        await adbShell(serial, [
            'input',
            'tap',
            String(Math.floor((bounds.left + bounds.right) / 2)),
            String(Math.floor((bounds.top + bounds.bottom) / 2)),
        ]);
        await pause(WATCH_MS);
        await capture(environment, 'opened', artifacts);
        await recording.stop();
        recording = undefined;
        const analysis = await mkdtemp(join(tmpdir(), 'caxri-running-turn-'));
        try {
            const video = join(analysis, 'opened.mp4');
            await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
            const { frames } = await readRecordingBand(video, timeline);
            const { departures, settledAt } = departuresFromFinalPicture(frames);
            if (departures > 0)
                throw new Error(
                    `The opened Chat timeline left its settled picture in ${departures} frames`,
                );
            await finish(environment, artifacts, {
                frames: frames.length,
                motion: 'live',
                settledAtMs: Math.round(settledAt),
                status: 'passed',
            });
        } finally {
            await rm(analysis, { force: true, recursive: true });
        }
    } finally {
        await recording?.stop();
        await fixture.stop();
    }
}

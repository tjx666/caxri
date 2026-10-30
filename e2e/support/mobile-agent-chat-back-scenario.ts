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
import type { GrayFrame } from './mobile-motion-analysis';
import { readRecordingBand } from './mobile-motion-analysis';

const PROMPT = 'Trace every place that reads the plan usage';
const LAST_NARRATION = 'Every reader of the plan usage is listed above.';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Each cycle opens the Chat, lets it settle, and films one Back. A single Back rarely lands on a slow frame on the
 * emulator, so the case repeats it.
 */
const CYCLES = 6;
const SETTLE_MS = 2_500;
const WATCH_MS = 1_500;

/**
 * Grayscale level a pixel must reach to count as light. The dark theme's background is about 45 and its body text is
 * thin, while react-navigation's default light background is 242.
 */
const LIGHT_LEVEL = 220;
/**
 * Share of light pixels that marks a frame as a light flash; ordinary Chat content stays far below it.
 */
const FLASH_SHARE = 0.15;

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
    durationMs: 20,
});

/**
 * A long finished turn, so the opened Chat holds a heavy timeline like the ones where the flash was reported.
 */
const script: FakeClaudeScript = {
    turns: [
        {
            prompt: PROMPT,
            steps: [
                ...Array.from({ length: 30 }, (_, round): FakeClaudeScriptStep[] => [
                    ...Array.from({ length: 4 }, (_, index) => search(round * 4 + index)),
                    { kind: 'text', text: `Round ${round}: the readers so far are listed.` },
                ]).flat(),
                { kind: 'text', text: LAST_NARRATION },
            ],
        },
    ],
};

const isFinished = (snapshot: AgentChatSnapshot): boolean =>
    !snapshot.activeTurnId &&
    snapshot.items.some((item) => item.type === 'agentMessage' && item.text === LAST_NARRATION);

const lightShare = ({ data }: GrayFrame): number => {
    let light = 0;
    for (const value of data) if (value >= LIGHT_LEVEL) light += 1;
    return light / data.length;
};

/**
 * Opens the Chat from its Session row, lets it settle, and films one Back gesture. Returns the light share of every
 * frame.
 */
async function filmOneBack({
    analysis,
    artifacts,
    band,
    cycle,
    display,
    environment,
    sessionId,
}: {
    analysis: string;
    artifacts: string[];
    band: { bottom: number; top: number };
    cycle: number;
    display: { height: number; width: number };
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath: string };
    sessionId: string;
}): Promise<number[]> {
    const { remoteVideoPath, serial } = environment;
    const { width } = display;
    const swipeY = Math.floor(display.height / 2);
    const row = await waitForMobile(
        async () =>
            (await mobileSemantics(serial)).find(
                ({ checkId }) => checkId === `session-row-${sessionId}`,
            ),
        Boolean,
        20_000,
    );
    const bounds = row && androidBounds(row.bounds);
    if (!bounds) throw new Error('The Session row is not laid out');
    await adbShell(serial, [
        'input',
        'tap',
        String(Math.floor((bounds.left + bounds.right) / 2)),
        String(Math.floor((bounds.top + bounds.bottom) / 2)),
    ]);
    await pause(SETTLE_MS);
    if (cycle === 0) await capture(environment, 'opened', artifacts);
    const recording = await startMobileFramebufferRecording(serial, remoteVideoPath);
    try {
        // The system Back gesture from the left edge, the way the flash was reported.
        await adbShell(serial, [
            'input',
            'swipe',
            '2',
            String(swipeY),
            String(Math.floor(width * 0.7)),
            String(swipeY),
            '150',
        ]);
        await pause(WATCH_MS);
    } finally {
        await recording.stop();
    }
    const video = join(analysis, `back-${cycle}.mp4`);
    await copyMobileFramebufferRecording(serial, remoteVideoPath, video);
    const { frames } = await readRecordingBand(video, band);
    return frames.map(lightShare);
}

/**
 * `MOB-CHAT-BACK-01`: going Back from a heavy Chat slides the detail away over the dark Sessions list. When the screens
 * had no navigation theme, any frame the content had not painted showed react-navigation's light default background, so
 * the phone flashed white before the detail left.
 *
 * The flash lasts a frame or two, so every recorded frame of each Back is judged by its share of light pixels.
 */
export async function executeMobileChatBackScenario(
    environment: MobileAgentScenarioEnvironment & { remoteVideoPath?: string },
    artifacts: string[],
): Promise<void> {
    const { remoteVideoPath, serial } = environment;
    if (!remoteVideoPath) throw new Error('MOB-CHAT-BACK-01 judges each Back from its recording');
    const fixture = await createMobileAcceptanceFixture({
        chatProvider: 'claude',
        claudeScript: script,
        mode: 'agent-chat',
        serial,
    });
    const analysis = await mkdtemp(join(tmpdir(), 'caxri-chat-back-'));
    try {
        const chat = fixture.agentChat;
        const sessionId = fixture.allowedSessionId;
        if (!chat || !sessionId) throw new Error('Chat fixture is unavailable');
        await fixture.pair();
        await chat.send({ text: PROMPT });
        await waitForMobile(() => chat.read(), isFinished, 60_000);
        const { size } = await mobileDisplayState(serial);
        const display = size.override ?? size.physical;
        const { height } = display;
        // Below the status bar and above the navigation bar, which the app does not draw.
        const band = { top: Math.floor(height * 0.06), bottom: Math.floor(height * 0.94) };
        const shares: number[][] = [];
        for (let cycle = 0; cycle < CYCLES; cycle += 1) {
            // eslint-disable-next-line no-await-in-loop -- each Back starts from the list the previous one returned to.
            const cycleShares = await filmOneBack({
                analysis,
                artifacts,
                band,
                cycle,
                display,
                environment: { ...environment, remoteVideoPath },
                sessionId,
            });
            shares.push(cycleShares);
        }
        await capture(environment, 'returned', artifacts);
        const flashFrames = shares.flat().filter((share) => share >= FLASH_SHARE).length;
        const peakShare = Math.max(...shares.flat());
        if (flashFrames > 0)
            throw new Error(
                `Back showed a light flash in ${flashFrames} frames (peak light share ${peakShare.toFixed(2)})`,
            );
        await finish(environment, artifacts, {
            cycles: CYCLES,
            frames: shares.flat().length,
            motion: 'live',
            peakLightShare: Number(peakShare.toFixed(3)),
            status: 'passed',
        });
    } finally {
        await rm(analysis, { force: true, recursive: true });
        await fixture.stop();
    }
}

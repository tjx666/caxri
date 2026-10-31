import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import type { ChatSwitchSample, RendererSurface } from './support/agent-chat-switch-samples.ts';
import {
    countChatReads,
    restartServerCore,
    SERVER_RESTART_BUDGET,
    summarize,
} from './support/agent-chat-switch-samples.ts';
import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createAdditionalShellSession,
    createProjectSession,
    launchCaxri,
    selectedSessionId,
    sessionCard,
    VISIBLE_SESSION,
} from './support/helpers.ts';
import type { RendererPerformanceWindow } from './support/renderer-performance.ts';

/**
 * Turns seeded into the measured Chat, alternating the fake Codex's two Markdown-heavy replies so the transcript is
 * long, highlighted, and several screens tall.
 */
const TURN_COUNT = Number(process.env.CAXRI_AGENT_CHAT_SWITCH_BENCHMARK_TURNS ?? 16);
/**
 * Switches measured per Renderer-side scenario (`keptAlive`, `cached`, `uncached`), enough for a stable p50 and a p95
 * that is not just the slowest sample. Each switch is measured from the same state the previous one left behind.
 */
const ITERATIONS = Number(process.env.CAXRI_AGENT_CHAT_SWITCH_BENCHMARK_ITERATIONS ?? 20);
/**
 * Switches measured after a Server Core restart. Each one kills Server Core, which Desktop's supervisor counts as a
 * crash: it replaces Server Core at most `maximumRestartAttempts` (3) times before 30 s of stable uptime reset the
 * budget, and a fourth kill leaves the window without a Server. Three samples stay inside that budget without adding
 * 30-second waits to the CI step.
 */
const COLD_ITERATIONS = Number(process.env.CAXRI_AGENT_CHAT_SWITCH_BENCHMARK_COLD_ITERATIONS ?? 3);
/**
 * Hard ceilings on the p50 time from the click until the conversation is readable, from issue #2215: a kept-alive Chat
 * within 100 ms, a Chat whose provider must start and resume its thread after a Server Core restart within one second.
 * The runner-derived baseline (`scripts/performance-baseline.agent-chat-switch.json`) is the tighter, statistical gate
 * once armed; these only catch a switch that became unusably slow.
 */
const READABLE_P50_CEILING_MS = { keptAlive: 100, cold: 1000 };
/**
 * Longest frame gap and Long Animation Frame a remount of a cached Chat may show. Mounting the whole timeline in one
 * frame measured 82-104 ms and 77-99 ms on 2026-10-30; mounting the tail first measured 36-48 ms and none. The budget
 * sits between them with room for runner noise; it is not the 34 ms (two frames) the experience aims for.
 */
const CACHED_FRAME_BUDGET = { maxFrameGapMs: 65, longestAnimationFrameMs: 50 };
/**
 * Frames sampled after a click before the switch counts as stuck. Far beyond any healthy load; it only bounds the run.
 */
const MAXIMUM_SAMPLED_FRAMES = 600;
/**
 * Frames still sampled once the content showed, long enough for every turn near the end to be laid out at its real
 * height (the settled timeline lays out an offscreen turn only once it nears the view).
 */
const SETTLING_FRAMES = 30;

/**
 * Newer Sessions created before the Chat counts as never evicted from keep-alive; far above its limit.
 */
const MAXIMUM_NEWER_SESSIONS = 12;
/**
 * The hidden window is sampled while the fake Codex's `longstream` reply streams, which takes about thirty seconds.
 */
const HIDDEN_STREAM_WINDOW_MS = 5000;
/**
 * Workbench React work while a hidden kept-alive Chat streams for {@link HIDDEN_STREAM_WINDOW_MS}. Following the stream
 * measured 1,368 renders and 134 ms on 2026-10-21; a frozen Chat measured 5 renders and 0.6 ms.
 */
const HIDDEN_STREAM_BUDGET = { renders: 40, actualDurationMs: 10 };

type ChatSwitchScenario = 'keptAlive' | 'cached' | 'uncached' | 'cold';

/**
 * Per-surface React budgets, calibrated from three profiling runs on 2026-10-20 (`docs/renderer-performance.md`). The
 * kept-alive Workbench budget is the one that guards the experience: a switch back to a mounted Chat that renders its
 * transcript again costs about as much as the `cached` remount.
 */
/*
 * The Workbench render budgets of `cached` and `uncached` count the idle backfill of the tail-first mount
 * (`use-agent-chat-tail-first-mount.ts`): a 16-turn Chat mounts 4 entries, then 6 more per idle commit, and each commit
 * renders the pane tree a few times. That trades a few more renders for a short first frame (82-104 ms down to 36-48 ms
 * on 2026-10-30). Measured 24-25 cached and 27-30 uncached on a quiet runner; the budgets leave about 20% for noise.
 * Renders before the tail-first mount were 9-10 and 17-20. Duration budgets are unchanged and still bound the total cost.
 */
const REACT_BUDGETS: Record<
    ChatSwitchScenario,
    Record<RendererSurface, { renders: number; actualDurationMs: number }>
> = {
    keptAlive: {
        'primary-sidebar': { renders: 4, actualDurationMs: 5 },
        'workbench': { renders: 8, actualDurationMs: 5 },
        'secondary-sidebar': { renders: 8, actualDurationMs: 5 },
    },
    cached: {
        'primary-sidebar': { renders: 4, actualDurationMs: 5 },
        'workbench': { renders: 30, actualDurationMs: 60 },
        'secondary-sidebar': { renders: 8, actualDurationMs: 5 },
    },
    uncached: {
        'primary-sidebar': { renders: 4, actualDurationMs: 5 },
        'workbench': { renders: 36, actualDurationMs: 90 },
        'secondary-sidebar': { renders: 10, actualDurationMs: 5 },
    },
    cold: {
        'primary-sidebar': { renders: 4, actualDurationMs: 5 },
        'workbench': { renders: 36, actualDurationMs: 90 },
        'secondary-sidebar': { renders: 10, actualDurationMs: 5 },
    },
};

/**
 * React work the Workbench commits over a quiet window with no interaction, bracketed as a Renderer scenario.
 */
async function measureWindow(
    page: Page,
    durationMs: number,
): Promise<{ commitCount: number; workbench: { renders: number; actualDurationMs: number } }> {
    return page.evaluate(async (duration) => {
        const performanceApi = (globalThis as RendererPerformanceWindow).caxriPerformance;
        if (!performanceApi) throw new Error('Renderer performance API is unavailable');
        const scenarioId = performanceApi.begin('agentChat.stream');
        await new Promise((resolve) => setTimeout(resolve, duration));
        const diagnostic = performanceApi.end(scenarioId);
        const { workbench } = diagnostic.react.surfaces;
        return {
            commitCount: diagnostic.react.commitCount,
            workbench: {
                renders: workbench.profiledRenderCount,
                actualDurationMs: Math.round(workbench.actualDurationTotalMs * 10) / 10,
            },
        };
    }, durationMs);
}

/**
 * The Primary Sidebar lists a Project's five most recently active Sessions; the Chat falls behind its "Show more" row
 * once enough newer Sessions push it out of keep-alive.
 */
/**
 * Where the pointer rests while a switch is measured: inside the Workbench, clear of the sidebar rows.
 */
const PARKED_POINTER = { x: 700, y: 400 };

async function revealSessionCard(page: Page, sessionId: string): Promise<void> {
    if ((await sessionCard(page, sessionId).count()) === 0) {
        await page.getByRole('treeitem', { name: /^Show \d+ more Sessions? in / }).click();
    }
    await expect(sessionCard(page, sessionId)).toBeVisible();
}

async function switchAndSettle(page: Page, sessionId: string): Promise<void> {
    await sessionCard(page, sessionId).click();
    await expect.poll(() => selectedSessionId(page)).toBe(sessionId);
    await expect(page.locator(VISIBLE_SESSION)).toHaveAttribute(
        'data-workbench-session-id',
        sessionId,
    );
}

/**
 * Clicks the Chat Session's card inside the page and samples every following painted frame until the transcript has
 * shown its real turns for {@link SETTLING_FRAMES} frames, so the timeline is the Renderer's own and no Playwright round
 * trip lands between two frames.
 */
async function measureSwitch(
    page: Page,
    userData: string,
    chatSessionId: string,
): Promise<ChatSwitchSample> {
    await revealSessionCard(page, chatSessionId);
    /*
     * Park the pointer outside the Primary Sidebar. The previous step's click leaves it resting on a Session row, and
     * that row's detail card opens 200ms later (the hover delay since #2531, 450ms before), inside this window. Opening
     * a card commits the sidebar about ten times (the popup mounts through nested updates), so the cached scenario read
     * 12 renders against a budget of 4 with no store or subscription change behind it. The card is a hover cost, not a
     * Session switch cost, so it must not be billed to the switch budget.
     */
    await page.mouse.move(PARKED_POINTER.x, PARKED_POINTER.y);
    const readsBefore = await countChatReads(userData);
    const sample = await page.evaluate(
        async ({ sessionId, maximumFrames, settlingFrames }) => {
            const sessionSelector = `.workbench-session[data-workbench-session-id="${CSS.escape(sessionId)}"]`;
            const distanceFromEnd = (log: Element | null | undefined): number | null =>
                log ? Math.round(log.scrollHeight - log.scrollTop - log.clientHeight) : null;
            /**
             * Resolves once the next frame has been painted. An animation-frame callback runs before that frame's
             * layout and resize observers, which is where the Chat pins its view to the end, so a sample taken there
             * reads a position the user never sees. The sample runs in a `user-blocking` task posted from that callback
             * instead, which Chromium runs right after the paint and ahead of ordinary tasks. A `MessageChannel` task
             * could queue behind React's own (the scheduler posts through one too) and read a commit the next frame
             * would still adjust: 1 to 4 of 40 cached switches read the top of the mounted tail, never painted, before
             * the resize observer pinned the view to the end.
             */
            const nextPaintedFrame = (): Promise<void> =>
                new Promise((resolve) => {
                    requestAnimationFrame(() => {
                        void scheduler.postTask(resolve, { priority: 'user-blocking' });
                    });
                });
            const performanceApi = (globalThis as RendererPerformanceWindow).caxriPerformance;
            if (!performanceApi) throw new Error('Renderer performance API is unavailable');
            const scenarioId = performanceApi.begin('session.switch');
            // The scenario's frame observer starts with the next frame; the click waits for it.
            await nextPaintedFrame();
            const initialLog = document.querySelector(`${sessionSelector} [role="log"]`);
            let scrollEvents = 0;
            const onScroll = (): void => {
                scrollEvents += 1;
            };
            initialLog?.addEventListener('scroll', onScroll);
            const distanceFromEndBefore = distanceFromEnd(initialLog);
            const result = {
                shownMs: null as number | null,
                placeholderMs: null as number | null,
                contentMs: null as number | null,
                interactiveMs: null as number | null,
                blankFrames: 0,
                maxFrameGapMs: 0,
                distanceFromEndBefore,
                distanceFromEndAfter: null as number | null,
                maxDistanceFromEndSettling: null as number | null,
            };
            const started = performance.now();
            let previous = started;
            let framesAfterContent = 0;
            document
                .querySelector<HTMLElement>(
                    `.session-card[data-session-id="${CSS.escape(sessionId)}"]`,
                )
                ?.click();
            for (let frame = 0; frame < maximumFrames; frame += 1) {
                // eslint-disable-next-line no-await-in-loop -- one sample per presented frame
                await nextPaintedFrame();
                const now = performance.now();
                result.maxFrameGapMs = Math.max(result.maxFrameGapMs, now - previous);
                previous = now;
                const elapsed = Math.round((now - started) * 10) / 10;
                const session = document.querySelector(sessionSelector);
                if (!session || session.hasAttribute('hidden')) continue;
                result.shownMs ??= elapsed;
                if (result.interactiveMs === null) {
                    const composer = session.querySelector('[aria-label="Message"]');
                    if (composer?.contains(document.activeElement)) result.interactiveMs = elapsed;
                }
                const log = session.querySelector('[role="log"]');
                if (result.contentMs !== null) {
                    result.maxDistanceFromEndSettling = Math.max(
                        result.maxDistanceFromEndSettling ?? 0,
                        distanceFromEnd(log) ?? 0,
                    );
                    framesAfterContent += 1;
                    if (framesAfterContent >= settlingFrames && result.interactiveMs !== null) {
                        break;
                    }
                    continue;
                }
                const hasPlaceholder = Boolean(
                    log?.querySelector(
                        ':scope [role="status"][aria-busy="true"] [data-slot="skeleton"]',
                    ),
                );
                const hasTurns = Boolean(log?.querySelector('[data-agent-chat-user-message]'));
                if (hasPlaceholder) result.placeholderMs ??= elapsed;
                if (!hasPlaceholder && !hasTurns) result.blankFrames += 1;
                if (hasTurns && !hasPlaceholder) {
                    result.contentMs = elapsed;
                    result.distanceFromEndAfter = distanceFromEnd(log);
                    result.maxDistanceFromEndSettling = result.distanceFromEndAfter;
                }
            }
            initialLog?.removeEventListener('scroll', onScroll);
            result.maxFrameGapMs = Math.round(result.maxFrameGapMs * 10) / 10;
            const diagnostic = performanceApi.end(scenarioId);
            const surface = (summary: {
                profiledRenderCount: number;
                actualDurationTotalMs: number;
            }) => ({
                renders: summary.profiledRenderCount,
                actualDurationMs: Math.round(summary.actualDurationTotalMs * 10) / 10,
            });
            return {
                ...result,
                scrollEvents,
                buildMode: diagnostic.buildMode,
                reactProfiler: diagnostic.capabilities.reactProfiler,
                react: {
                    commitCount: diagnostic.react.commitCount,
                    surfaces: {
                        'primary-sidebar': surface(diagnostic.react.surfaces['primary-sidebar']),
                        'workbench': surface(diagnostic.react.surfaces.workbench),
                        'secondary-sidebar': surface(
                            diagnostic.react.surfaces['secondary-sidebar'],
                        ),
                    },
                },
                longestAnimationFrameMs:
                    Math.round(diagnostic.longAnimationFrames.maxDurationMs * 10) / 10,
            };
        },
        {
            sessionId: chatSessionId,
            maximumFrames: MAXIMUM_SAMPLED_FRAMES,
            settlingFrames: SETTLING_FRAMES,
        },
    );
    await expect.poll(() => selectedSessionId(page)).toBe(chatSessionId);
    // The settling frames end long after a read was answered, so its log records are already written.
    return { ...sample, readRequests: (await countChatReads(userData)) - readsBefore };
}

/**
 * Measures switching to a long Agent Chat from the three states a Session can be in: kept alive behind the visible one,
 * evicted from keep-alive with its conversation still cached, and evicted with nothing cached (after a reload). Frame
 * timings are diagnostic; the gates are the deterministic invariants (no frame shows a blank transcript, and a
 * kept-alive Chat comes back on the first frame without scrolling) plus per-surface React budgets.
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('benchmark: switching to a long Agent Chat Session', async ({}, testInfo) => {
    test.skip(
        process.env.CAXRI_AGENT_CHAT_SWITCH_BENCHMARK !== '1',
        'benchmark: run through bun run benchmark:chat-switch',
    );
    test.setTimeout(900_000);
    const created = await mkdtemp(join(tmpdir(), 'caxri-chat-switch-benchmark-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const running = await launchCaxri({ agentMode, userDataDir: userData, testRootPath: root });
    try {
        const { page } = running;
        await createProjectSession(page, 'shell');
        const chatSessionId = await selectedSessionId(page);
        await openAgentChat(page, 'Codex Chat');
        const chat = page.locator(`[data-workbench-session-id="${chatSessionId}"]`);
        const message = chat.getByRole('textbox', { name: 'Message' });
        for (let turn = 1; turn <= TURN_COUNT; turn += 1) {
            // eslint-disable-next-line no-await-in-loop -- each reply must finish before the next message is accepted
            await message.fill(`${turn % 2 === 0 ? 'codeblocks' : 'table'} please, turn ${turn}`);
            // eslint-disable-next-line no-await-in-loop -- see above
            await message.press('Enter');
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect(chat.locator('[data-agent-chat-user-message]')).toHaveCount(turn, {
                timeout: 30_000,
            });
            // eslint-disable-next-line no-await-in-loop -- see above
            await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0, {
                timeout: 30_000,
            });
        }

        // Newer Sessions push the Chat out of keep-alive, however many it retains; its conversation stays in the
        // Renderer's cache.
        const otherSessionIds: string[] = [];
        const chatWorkbench = page.locator(`[data-workbench-session-id="${chatSessionId}"]`);
        // eslint-disable-next-line no-await-in-loop -- eviction is observed after each new Session
        while ((await chatWorkbench.count()) > 0) {
            expect(otherSessionIds.length, 'keep-alive never evicted the Chat').toBeLessThan(
                MAXIMUM_NEWER_SESSIONS,
            );
            // eslint-disable-next-line no-await-in-loop -- each creation targets the newly selected Session
            await createAdditionalShellSession(page);
            // eslint-disable-next-line no-await-in-loop -- see above
            otherSessionIds.push(await selectedSessionId(page));
        }
        const lastOtherSessionId = otherSessionIds.at(-1)!;
        /**
         * Selecting the newer Sessions again, oldest first, evicts the Chat from keep-alive once more without creating
         * Sessions: they become the most recent ones and the Chat the least recent.
         */
        const evictChat = async (): Promise<void> => {
            for (const sessionId of otherSessionIds) {
                // eslint-disable-next-line no-await-in-loop -- each selection changes keep-alive order
                if ((await chatWorkbench.count()) === 0) break;
                // eslint-disable-next-line no-await-in-loop -- see above
                await revealSessionCard(page, sessionId);
                // eslint-disable-next-line no-await-in-loop -- see above
                await switchAndSettle(page, sessionId);
            }
            await expect(chatWorkbench).toHaveCount(0);
        };
        const cachedSamples: ChatSwitchSample[] = [];
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
            // eslint-disable-next-line no-await-in-loop -- every switch starts from an evicted Chat
            if (iteration > 0) await evictChat();
            // eslint-disable-next-line no-await-in-loop -- see above
            cachedSamples.push(await measureSwitch(page, userData, chatSessionId));
        }
        await page.screenshot({ path: testInfo.outputPath('chat-after-cached-switch.png') });

        const keptAliveSamples: ChatSwitchSample[] = [];
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
            // eslint-disable-next-line no-await-in-loop -- every switch starts from another Session
            await switchAndSettle(page, lastOtherSessionId);
            // eslint-disable-next-line no-await-in-loop -- see above
            keptAliveSamples.push(await measureSwitch(page, userData, chatSessionId));
        }

        // A long reply streams into the Chat while its Session is kept alive behind another one.
        await message.fill('longstream please');
        await message.press('Enter');
        // The reply thinks quietly first; the window starts once its text is arriving.
        await expect(chat.getByText(/^Paragraph 01:/u)).toBeVisible({ timeout: 30_000 });
        await switchAndSettle(page, lastOtherSessionId);
        const hiddenStreaming = await measureWindow(page, HIDDEN_STREAM_WINDOW_MS);
        const keptAliveStreaming = await measureSwitch(page, userData, chatSessionId);
        await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0, {
            timeout: 60_000,
        });

        /**
         * Leaves the Chat for another Session and, after `prepare`, reloads the Renderer so nothing of the Chat is
         * cached, then waits until the other Session is back on screen.
         */
        const leaveAndReload = async (prepare?: () => Promise<void>): Promise<void> => {
            await switchAndSettle(page, lastOtherSessionId);
            await prepare?.();
            await page.reload();
            await revealSessionCard(page, chatSessionId);
            await expect(page.locator(VISIBLE_SESSION)).toHaveAttribute(
                'data-workbench-session-id',
                lastOtherSessionId,
            );
        };
        const uncachedSamples: ChatSwitchSample[] = [];
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
            // eslint-disable-next-line no-await-in-loop -- every switch starts from a fresh Renderer
            await leaveAndReload();
            // eslint-disable-next-line no-await-in-loop -- see above
            uncachedSamples.push(await measureSwitch(page, userData, chatSessionId));
        }
        await page.screenshot({ path: testInfo.outputPath('chat-after-uncached-switch.png') });

        expect(
            COLD_ITERATIONS,
            'cold switches within the Server restart budget',
        ).toBeLessThanOrEqual(SERVER_RESTART_BUDGET);
        const coldSamples: ChatSwitchSample[] = [];
        for (let iteration = 0; iteration < COLD_ITERATIONS; iteration += 1) {
            // eslint-disable-next-line no-await-in-loop -- every switch starts from a replaced Server Core
            await leaveAndReload(() => restartServerCore(page));
            // eslint-disable-next-line no-await-in-loop -- see above
            coldSamples.push(await measureSwitch(page, userData, chatSessionId));
        }
        await page.screenshot({ path: testInfo.outputPath('chat-after-cold-switch.png') });

        const samples: Record<ChatSwitchScenario, ChatSwitchSample[]> = {
            keptAlive: keptAliveSamples,
            cached: cachedSamples,
            uncached: uncachedSamples,
            cold: coldSamples,
        };
        const receipt = {
            kind: 'agent-chat-session-switch',
            turnCount: TURN_COUNT,
            scenarios: {
                keptAlive: summarize(keptAliveSamples),
                cached: summarize(cachedSamples),
                uncached: summarize(uncachedSamples),
                cold: summarize(coldSamples),
            },
            hiddenStreaming: {
                ...hiddenStreaming,
                keptAliveStreaming: summarize([keptAliveStreaming]),
            },
            /**
             * Every switch as measured; the baseline and the public receipt read only the summaries above.
             */
            samples: { ...samples, keptAliveStreaming: [keptAliveStreaming] },
        };
        const receiptDirectory = join(process.cwd(), 'test-results', 'receipts');
        await mkdir(receiptDirectory, { recursive: true });
        await writeFile(
            join(receiptDirectory, 'agent-chat-session-switch.json'),
            `${JSON.stringify(receipt, null, 2)}\n`,
            'utf8',
        );
        process.stdout.write(`CAXRI_AGENT_CHAT_SWITCH_BENCHMARK ${JSON.stringify(receipt)}\n`);

        const { scenarios } = receipt;
        // Times and budgets are judged on the median switch; one slow sample on a busy runner does not fail the run.
        expect(scenarios.cached.maxFrameGapMs.p50, 'cached max frame gap').toBeLessThanOrEqual(
            CACHED_FRAME_BUDGET.maxFrameGapMs,
        );
        expect(
            scenarios.cached.longestAnimationFrameMs.p50,
            'cached Long Animation Frame',
        ).toBeLessThanOrEqual(CACHED_FRAME_BUDGET.longestAnimationFrameMs);
        expect(scenarios.keptAlive.readableMs.p50, 'keptAlive readable').toBeLessThanOrEqual(
            READABLE_P50_CEILING_MS.keptAlive,
        );
        expect(scenarios.cold.readableMs.p50, 'cold readable').toBeLessThanOrEqual(
            READABLE_P50_CEILING_MS.cold,
        );
        for (const name of ['keptAlive', 'cached', 'uncached', 'cold'] as const) {
            const scenarioSamples = samples[name];
            for (const [index, sample] of scenarioSamples.entries()) {
                const label = `${name} switch ${index + 1}`;
                expect(sample.buildMode, 'run through bun run benchmark:chat-switch').toBe(
                    'profiling',
                );
                expect(sample.reactProfiler).toBe('available');
                expect(sample.contentMs, `${label} never showed the conversation`).not.toBeNull();
                expect(sample.interactiveMs, `${label} never focused the composer`).not.toBeNull();
                expect(sample.blankFrames, `${label} showed a blank transcript`).toBe(0);
                // The Chat was left following its latest reply, so every painted frame shows the end.
                expect(
                    sample.maxDistanceFromEndSettling,
                    `${label} was painted away from the latest reply`,
                ).toBeLessThanOrEqual(1);
            }
            const budgets = Object.entries(REACT_BUDGETS[name]);
            for (const [surface, budget] of budgets) {
                const measured = scenarios[name].react.surfaces[surface as RendererSurface];
                expect(measured.renders.p50, `${name} ${surface} renders`).toBeLessThanOrEqual(
                    budget.renders,
                );
                expect(
                    measured.actualDurationMs.p50,
                    `${name} ${surface} React duration`,
                ).toBeLessThanOrEqual(budget.actualDurationMs);
            }
        }
        for (const keptAlive of keptAliveSamples) {
            expect(keptAlive.contentMs).toBe(keptAlive.shownMs);
            expect(keptAlive.placeholderMs).toBeNull();
            expect(keptAlive.scrollEvents).toBe(0);
            expect(keptAlive.distanceFromEndAfter).toBe(keptAlive.distanceFromEndBefore);
            expect(keptAlive.readRequests).toBe(0);
        }
        // A remount draws the cached conversation at once instead of reading it again.
        for (const cached of cachedSamples) {
            expect(cached.placeholderMs).toBeNull();
            expect(cached.readRequests).toBe(0);
        }
        for (const uncached of uncachedSamples) expect(uncached.readRequests).toBe(1);
        // After a Server Core restart the read also starts the provider; patches that follow may read again.
        for (const cold of coldSamples) expect(cold.readRequests).toBeGreaterThanOrEqual(1);
        // A hidden kept-alive Chat does no React work for its stream, and still comes back drawn at once.
        expect(
            hiddenStreaming.workbench.renders,
            'hidden streaming Workbench renders',
        ).toBeLessThanOrEqual(HIDDEN_STREAM_BUDGET.renders);
        expect(
            hiddenStreaming.workbench.actualDurationMs,
            'hidden streaming Workbench React duration',
        ).toBeLessThanOrEqual(HIDDEN_STREAM_BUDGET.actualDurationMs);
        expect(keptAliveStreaming.blankFrames).toBe(0);
        expect(keptAliveStreaming.placeholderMs).toBeNull();
        expect(keptAliveStreaming.contentMs).toBe(keptAliveStreaming.shownMs);
        expect(keptAliveStreaming.readRequests).toBe(0);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

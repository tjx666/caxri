import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { RendererPerformanceScenarioDiagnostic } from '@caxri/protocol';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
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
const TURN_COUNT = 16;
/**
 * Frames sampled after a click before the switch counts as stuck. Far beyond any healthy load; it only bounds the run.
 */
const MAXIMUM_SAMPLED_FRAMES = 600;
/**
 * Frames still sampled once the content showed, long enough for every turn near the end to be laid out at its real
 * height (the settled timeline lays out an offscreen turn only once it nears the view).
 */
const SETTLING_FRAMES = 30;

type RendererSurface = keyof RendererPerformanceScenarioDiagnostic['react']['surfaces'];
type ChatSwitchScenario = 'keptAlive' | 'cached' | 'uncached';

/**
 * Per-surface React budgets, calibrated from three profiling runs on 2026-10-20 (`docs/renderer-performance.md`). The
 * kept-alive Workbench budget is the one that guards the experience: a switch back to a mounted Chat that renders its
 * transcript again costs about as much as the `cached` remount.
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
        'workbench': { renders: 12, actualDurationMs: 60 },
        'secondary-sidebar': { renders: 8, actualDurationMs: 5 },
    },
    uncached: {
        'primary-sidebar': { renders: 4, actualDurationMs: 5 },
        'workbench': { renders: 20, actualDurationMs: 90 },
        'secondary-sidebar': { renders: 10, actualDurationMs: 5 },
    },
};

/**
 * What one Session switch to the Chat looked like, frame by frame from the click. Times are milliseconds from the
 * click; a field is `null` when the state never appeared.
 */
interface ChatSwitchSample {
    /**
     * The first frame that showed the target Session.
     */
    shownMs: number | null;
    /**
     * The first frame that drew the transcript's placeholder turns.
     */
    placeholderMs: number | null;
    /**
     * The first frame that drew the real turns with no placeholder left.
     */
    contentMs: number | null;
    /**
     * Frames that showed the Session with neither placeholder nor turns: what the user sees as a blank transcript.
     */
    blankFrames: number;
    /**
     * Longest gap between two sampled frames, the main-thread block the user sees as the switch freezing.
     */
    maxFrameGapMs: number;
    /**
     * `scroll` events the transcript fired from the click on, when it existed before the click.
     */
    scrollEvents: number;
    /**
     * The transcript's distance from its end before the click and in the first frame that showed its content.
     */
    distanceFromEndBefore: number | null;
    distanceFromEndAfter: number | null;
    /**
     * The farthest from its end the transcript was painted over the frames after its content first showed: a Chat left
     * following its latest reply that comes back anywhere else is seen jumping down to it.
     */
    maxDistanceFromEndSettling: number | null;
    /**
     * `agentChat.read` requests Server Core answered for the switch.
     */
    readRequests: number;
    /**
     * The Renderer build the scenario ran in. React counts are real only in a `profiling` build with the Profiler
     * `available`.
     */
    buildMode: RendererPerformanceScenarioDiagnostic['buildMode'];
    reactProfiler: RendererPerformanceScenarioDiagnostic['capabilities']['reactProfiler'];
    /**
     * React work from the click to the end of the settling frames, from the Renderer's own `session.switch` scenario:
     * commits, and per surface the Profiler renders and their summed actual duration.
     */
    react: {
        commitCount: number;
        surfaces: Record<RendererSurface, { renders: number; actualDurationMs: number }>;
    };
    /**
     * The longest Long Animation Frame Chromium reported in the same window, or `0` when it reported none.
     */
    longestAnimationFrameMs: number;
}

/**
 * Counts distinct `agentChat.read` requests in Server Core's log. A request from the Renderer is recorded twice, once
 * where the control relay admits it and once where its domain answers it, and both records carry its `requestId`.
 */
async function countChatReads(userData: string): Promise<number> {
    let contents: string;
    try {
        contents = await readFile(join(userData, 'logs', 'server-core.jsonl'), 'utf8');
    } catch {
        return 0;
    }
    const requests = contents
        .split('\n')
        .filter(Boolean)
        .map(
            (line) =>
                JSON.parse(line) as {
                    event?: string;
                    correlationId?: string;
                    context?: { requestId?: string };
                    fields?: { method?: string };
                },
        )
        .filter(
            (record) =>
                record.event === 'ipc.request' && record.fields?.method === 'agentChat.read',
        )
        .map((record) => record.context?.requestId ?? record.correlationId);
    return new Set(requests).size;
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
    const readsBefore = await countChatReads(userData);
    const sample = await page.evaluate(
        async ({ sessionId, maximumFrames, settlingFrames }) => {
            const sessionSelector = `.workbench-session[data-workbench-session-id="${CSS.escape(sessionId)}"]`;
            const distanceFromEnd = (log: Element | null | undefined): number | null =>
                log ? Math.round(log.scrollHeight - log.scrollTop - log.clientHeight) : null;
            /**
             * Resolves once the next frame has been rendered. An animation-frame callback runs before that frame's
             * layout and resize observers, which is where the Chat pins its view to the end, so a sample taken there
             * reads a position the user never sees; the task posted from it runs after the frame is painted.
             */
            const nextPaintedFrame = (): Promise<void> =>
                new Promise((resolve) => {
                    requestAnimationFrame(() => {
                        const channel = new MessageChannel();
                        channel.port1.addEventListener('message', () => resolve(), { once: true });
                        channel.port1.start();
                        channel.port2.postMessage(undefined);
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
                const log = session.querySelector('[role="log"]');
                if (result.contentMs !== null) {
                    result.maxDistanceFromEndSettling = Math.max(
                        result.maxDistanceFromEndSettling ?? 0,
                        distanceFromEnd(log) ?? 0,
                    );
                    framesAfterContent += 1;
                    if (framesAfterContent >= settlingFrames) break;
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
    test.setTimeout(300_000);
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

        // Three newer Sessions push the Chat out of keep-alive; its conversation stays in the Renderer's cache.
        const otherSessionIds: string[] = [];
        for (let count = 0; count < 3; count += 1) {
            // eslint-disable-next-line no-await-in-loop -- each creation targets the newly selected Session
            await createAdditionalShellSession(page);
            // eslint-disable-next-line no-await-in-loop -- see above
            otherSessionIds.push(await selectedSessionId(page));
        }
        await expect(page.locator(`[data-workbench-session-id="${chatSessionId}"]`)).toHaveCount(0);
        const cached = await measureSwitch(page, userData, chatSessionId);

        await switchAndSettle(page, otherSessionIds.at(-1)!);
        const keptAlive = await measureSwitch(page, userData, chatSessionId);

        await switchAndSettle(page, otherSessionIds.at(-1)!);
        await page.reload();
        await expect(sessionCard(page, chatSessionId)).toBeVisible();
        await expect(page.locator(VISIBLE_SESSION)).toHaveAttribute(
            'data-workbench-session-id',
            otherSessionIds.at(-1)!,
        );
        const uncached = await measureSwitch(page, userData, chatSessionId);
        await page.screenshot({ path: testInfo.outputPath('chat-after-uncached-switch.png') });

        const receipt = {
            kind: 'agent-chat-session-switch',
            turnCount: TURN_COUNT,
            scenarios: { keptAlive, cached, uncached },
        };
        const receiptDirectory = join(process.cwd(), 'test-results', 'receipts');
        await mkdir(receiptDirectory, { recursive: true });
        await writeFile(
            join(receiptDirectory, 'agent-chat-session-switch.json'),
            `${JSON.stringify(receipt, null, 2)}\n`,
            'utf8',
        );
        process.stdout.write(`CAXRI_AGENT_CHAT_SWITCH_BENCHMARK ${JSON.stringify(receipt)}\n`);

        for (const name of ['keptAlive', 'cached', 'uncached'] as const) {
            const scenario = receipt.scenarios[name];
            expect(scenario.buildMode, 'run through bun run benchmark:chat-switch').toBe(
                'profiling',
            );
            expect(scenario.reactProfiler).toBe('available');
            expect(scenario.contentMs, `${name} never showed the conversation`).not.toBeNull();
            expect(scenario.blankFrames, `${name} showed a blank transcript`).toBe(0);
            // The Chat was left following its latest reply, so every painted frame shows the end.
            expect(
                scenario.maxDistanceFromEndSettling,
                `${name} was painted away from the latest reply`,
            ).toBeLessThanOrEqual(1);
            const budgets = Object.entries(REACT_BUDGETS[name]);
            for (const [surface, budget] of budgets) {
                const measured = scenario.react.surfaces[surface as RendererSurface];
                expect(measured.renders, `${name} ${surface} renders`).toBeLessThanOrEqual(
                    budget.renders,
                );
                expect(
                    measured.actualDurationMs,
                    `${name} ${surface} React duration`,
                ).toBeLessThanOrEqual(budget.actualDurationMs);
            }
        }
        expect(keptAlive.contentMs).toBe(keptAlive.shownMs);
        expect(keptAlive.placeholderMs).toBeNull();
        expect(keptAlive.scrollEvents).toBe(0);
        expect(keptAlive.distanceFromEndAfter).toBe(keptAlive.distanceFromEndBefore);
        expect(keptAlive.readRequests).toBe(0);
        // A remount draws the cached conversation at once instead of reading it again.
        expect(cached.placeholderMs).toBeNull();
        expect(cached.readRequests).toBe(0);
        expect(uncached.readRequests).toBe(1);
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

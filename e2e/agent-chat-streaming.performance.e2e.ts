import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { CDPSession } from '@playwright/test';

import { fakeCodexChatAgentMode, openAgentChat } from './support/agent-chat-fixture.ts';
import type { Page } from './support/fixtures.ts';
import { expect, test } from './support/fixtures.ts';
import {
    closeAppQuietly,
    createProjectSession,
    launchCaxri,
    pageRequest,
    selectedSessionId,
} from './support/helpers.ts';
import { measureAppMemory } from './support/process-resources.ts';
import type { RendererPerformanceWindow } from './support/renderer-performance.ts';

/**
 * How long the app sits idle after the warm-up turn before its idle memory is read.
 */
const IDLE_SETTLE_MS = 5000;

/**
 * Per-workload budgets, calibrated from three profiling runs (`docs/renderer-performance.md`). Renderer work and memory
 * growth stay diagnostic beside them; see the doc for why.
 */
const BUDGETS: Record<
    StreamingWorkload,
    { workbenchRenders: number; workbenchActualDurationMs: number; heapGrowthMb: number }
> = {
    bigstream: { workbenchRenders: 3800, workbenchActualDurationMs: 1000, heapGrowthMb: 42 },
    toolstorm: { workbenchRenders: 800, workbenchActualDurationMs: 400, heapGrowthMb: 8 },
    richreply: { workbenchRenders: 3200, workbenchActualDurationMs: 1300, heapGrowthMb: 34 },
};

type StreamingWorkload = 'bigstream' | 'toolstorm' | 'richreply';

const WORKLOADS: readonly StreamingWorkload[] = ['bigstream', 'toolstorm', 'richreply'];

/**
 * What the fake Codex shows last for each workload, so the window ends only once the turn is fully drawn.
 */
const FINAL_TEXT: Record<StreamingWorkload, RegExp> = {
    bigstream: /^Section \d+: step\d{3}$/u,
    toolstorm: /^Searched 300 steps\.$/u,
    richreply: /^Linked 120 steps\.$/u,
};

/**
 * A `gh` on `PATH` that answers the GitHub reads `richreply`'s links and tracker cards trigger, so the benchmark never
 * reaches GitHub. Numbers from 1000 are open pull requests and the rest open issues, matching the fake Codex workload.
 */
async function writeFakeGh(directory: string): Promise<string> {
    const bin = join(directory, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(
        join(bin, 'gh'),
        `#!/bin/sh
case "$1 $2" in
  "auth token") printf 'fixture-token' ;;
  "api --hostname")
    number=$(basename "$4")
    pull=''
    if [ "$number" -lt 2000 ]; then pull=',"pull_request":{"merged_at":null}'; fi
    printf '{"number":%s,"state":"open","title":"Widget change %s","html_url":"https://github.com/%s","created_at":"2026-01-01T00:00:00Z","user":{"login":"octocat"}%s}' "$number" "$number" "$4" "$pull" ;;
  *) printf 'unsupported gh call
' >&2; exit 1 ;;
esac
`,
        'utf8',
    );
    await chmod(join(bin, 'gh'), 0o755);
    return bin;
}

/**
 * Main-thread time Chromium spent in the Renderer, in milliseconds, from `Performance.getMetrics`. `taskMs` is all of
 * it, the "UI work" a reply costs; the others are its script, style, and layout shares.
 */
interface RendererWork {
    taskMs: number;
    scriptMs: number;
    recalcStyleMs: number;
    layoutMs: number;
}

interface StreamingSample {
    /**
     * Wall time from sending the message to the turn drawn complete, which the fake's own pace dominates.
     */
    wallMs: number;
    rendererWork: RendererWork;
    /**
     * Renderer JS heap after a forced garbage collection, before and after the turn, in MB.
     */
    heapBeforeMb: number;
    heapGrowthMb: number;
    /**
     * Resident memory of the whole app (Electron and Server processes, no Agent) before and after the turn, in MB.
     */
    appMemoryBeforeMb: number;
    appMemoryGrowthMb: number;
    buildMode: string;
    reactProfiler: string;
    react: {
        commitCount: number;
        workbench: { renders: number; actualDurationMs: number };
    };
    longAnimationFrames: { count: number; maxDurationMs: number; totalBlockingDurationMs: number };
    frames: { sampleCount: number; maxIntervalMs: number; missedFrameCount: number };
}

const round = (value: number): number => Math.round(value * 10) / 10;

async function metrics(cdp: CDPSession): Promise<Map<string, number>> {
    const { metrics: values } = await cdp.send('Performance.getMetrics');
    return new Map(values.map(({ name, value }) => [name, value]));
}

/**
 * The Renderer JS heap in MB after two forced collections, so garbage a turn left behind does not count as growth.
 */
async function collectedHeapMb(cdp: CDPSession): Promise<number> {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    return round(((await metrics(cdp)).get('JSHeapUsedSize') ?? 0) / 1024 / 1024);
}

function rendererWork(before: Map<string, number>, after: Map<string, number>): RendererWork {
    const delta = (name: string): number =>
        round(((after.get(name) ?? 0) - (before.get(name) ?? 0)) * 1000);
    return {
        taskMs: delta('TaskDuration'),
        scriptMs: delta('ScriptDuration'),
        recalcStyleMs: delta('RecalcStyleDuration'),
        layoutMs: delta('LayoutDuration'),
    };
}

/**
 * Sends `workload` to the visible Chat and measures the Renderer until the turn is drawn complete.
 */
async function measureWorkload(
    page: Page,
    cdp: CDPSession,
    appMemory: () => Promise<number>,
    workload: StreamingWorkload,
): Promise<StreamingSample> {
    const chat = page.locator(`[data-workbench-session-id="${await selectedSessionId(page)}"]`);
    const message = chat.getByRole('textbox', { name: 'Message' });
    const heapBeforeMb = await collectedHeapMb(cdp);
    const appMemoryBeforeMb = await appMemory();
    await message.fill(`${workload} please`);
    const before = await metrics(cdp);
    const scenarioId = await page.evaluate(() => {
        const performanceApi = (globalThis as RendererPerformanceWindow).caxriPerformance;
        if (!performanceApi) throw new Error('Renderer performance API is unavailable');
        return performanceApi.begin('agentChat.stream');
    });
    const startedAt = performance.now();
    await message.press('Enter');
    await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(1, { timeout: 30_000 });
    await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0, { timeout: 90_000 });
    await expect(chat.getByText(FINAL_TEXT[workload]).last()).toBeVisible({ timeout: 10_000 });
    const diagnostic = await page.evaluate(async (id) => {
        // Two painted frames, so the final text's layout and paint land inside the window.
        for (let frame = 0; frame < 2; frame += 1)
            // eslint-disable-next-line no-await-in-loop -- one frame after another
            await new Promise((resolve) => requestAnimationFrame(resolve));
        const performanceApi = (globalThis as RendererPerformanceWindow).caxriPerformance;
        if (!performanceApi) throw new Error('Renderer performance API is unavailable');
        return performanceApi.end(id);
    }, scenarioId);
    const wallMs = round(performance.now() - startedAt);
    const after = await metrics(cdp);
    const heapAfterMb = await collectedHeapMb(cdp);
    const appMemoryAfterMb = await appMemory();
    const { workbench } = diagnostic.react.surfaces;
    return {
        wallMs,
        rendererWork: rendererWork(before, after),
        heapBeforeMb,
        heapGrowthMb: round(heapAfterMb - heapBeforeMb),
        appMemoryBeforeMb,
        appMemoryGrowthMb: round(appMemoryAfterMb - appMemoryBeforeMb),
        buildMode: diagnostic.buildMode,
        reactProfiler: diagnostic.capabilities.reactProfiler,
        react: {
            commitCount: diagnostic.react.commitCount,
            workbench: {
                renders: workbench.profiledRenderCount,
                actualDurationMs: round(workbench.actualDurationTotalMs),
            },
        },
        longAnimationFrames: {
            count: diagnostic.longAnimationFrames.count,
            maxDurationMs: round(diagnostic.longAnimationFrames.maxDurationMs),
            totalBlockingDurationMs: round(diagnostic.longAnimationFrames.totalBlockingDurationMs),
        },
        frames: {
            sampleCount: diagnostic.frames.sampleCount,
            maxIntervalMs: round(diagnostic.frames.maxIntervalMs),
            missedFrameCount: diagnostic.frames.missedFrameCount,
        },
    };
}

/**
 * Measures what an Agent Chat the user is watching costs while it streams: a 50 KB Markdown reply in token-sized deltas
 * (`bigstream`), 600 tool updates (`toolstorm`), and a reply full of pull request, issue, file, and skill references
 * after forty tracker cards (`richreply`), plus the whole app's idle memory. The gates are per-workload React budgets
 * and Renderer heap growth; main-thread time, frames, and resident memory stay diagnostic. The workloads and readings
 * follow PandaCode's published comparison with T3 Code (`.agents/skills/competitors/references/pandacode.md`).
 */
// eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
test('benchmark: streaming into a visible Agent Chat', async ({}) => {
    test.skip(
        process.env.CAXRI_AGENT_CHAT_STREAMING_BENCHMARK !== '1',
        'benchmark: run through bun run benchmark:chat-streaming',
    );
    test.setTimeout(300_000);
    const created = await mkdtemp(join(tmpdir(), 'caxri-chat-streaming-benchmark-'));
    const directory = await realpath(created);
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    // A Project skill, so `richreply`'s inline `repo-helper` shows as one.
    const skillDirectory = join(root, '.agents', 'skills', 'repo-helper');
    await mkdir(skillDirectory, { recursive: true });
    await writeFile(
        join(skillDirectory, 'SKILL.md'),
        '---\nname: repo-helper\ndescription: Helps inside this Project\n---\n\nHelp.\n',
        'utf8',
    );
    const agentMode = await fakeCodexChatAgentMode(directory, userData);
    const bin = await writeFakeGh(directory);
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: { PATH: `${bin}:${process.env.PATH ?? ''}` },
    });
    try {
        const { app, page } = running;
        await createProjectSession(page, 'shell');
        await openAgentChat(page, 'Codex Chat');
        const serverPid = (await pageRequest<{ pid: number }>(page, 'host.status')).pid;
        const appMemory = async (): Promise<number> =>
            (await measureAppMemory(app, serverPid)).totalMb;
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Performance.enable');

        // One Markdown-heavy turn loads the Chat's lazy code (Markdown, code colorizing) before anything is measured.
        const chat = page.locator(`[data-workbench-session-id="${await selectedSessionId(page)}"]`);
        const message = chat.getByRole('textbox', { name: 'Message' });
        await message.fill('table please');
        await message.press('Enter');
        await expect(chat.locator('[data-agent-chat-user-message]')).toHaveCount(1, {
            timeout: 30_000,
        });
        await expect(chat.getByRole('button', { name: 'Stop' })).toHaveCount(0, {
            timeout: 30_000,
        });
        // Opening the skill menu reads the Agent's skills, which the reply's skill marks share.
        await message.fill('$repo');
        await expect(chat.getByRole('option', { name: /repo-helper/u }).first()).toBeVisible();
        await message.fill('');
        await page.waitForTimeout(IDLE_SETTLE_MS);
        const idleHeapMb = await collectedHeapMb(cdp);
        const idle = await measureAppMemory(app, serverPid);

        const workloads = {} as Record<StreamingWorkload, StreamingSample>;
        for (const workload of WORKLOADS)
            // eslint-disable-next-line no-await-in-loop -- one turn after another in the same Chat
            workloads[workload] = await measureWorkload(page, cdp, appMemory, workload);

        const receipt = {
            kind: 'agent-chat-streaming',
            idle: { ...idle, rendererHeapMb: idleHeapMb },
            workloads,
        };
        const receiptDirectory = join(process.cwd(), 'test-results', 'receipts');
        await mkdir(receiptDirectory, { recursive: true });
        await writeFile(
            join(receiptDirectory, 'agent-chat-streaming.json'),
            `${JSON.stringify(receipt, null, 2)}\n`,
            'utf8',
        );
        process.stdout.write(`CAXRI_AGENT_CHAT_STREAMING_BENCHMARK ${JSON.stringify(receipt)}\n`);

        for (const workload of WORKLOADS) {
            const sample = receipt.workloads[workload];
            const budget = BUDGETS[workload];
            expect(sample.buildMode, 'run through bun run benchmark:chat-streaming').toBe(
                'profiling',
            );
            expect(sample.reactProfiler).toBe('available');
            expect(
                sample.react.workbench.renders,
                `${workload} Workbench renders`,
            ).toBeLessThanOrEqual(budget.workbenchRenders);
            expect(
                sample.react.workbench.actualDurationMs,
                `${workload} Workbench React duration`,
            ).toBeLessThanOrEqual(budget.workbenchActualDurationMs);
            expect(sample.heapGrowthMb, `${workload} Renderer heap growth`).toBeLessThanOrEqual(
                budget.heapGrowthMb,
            );
        }
    } finally {
        await closeAppQuietly(running.app);
        await rm(directory, { recursive: true, force: true });
    }
});

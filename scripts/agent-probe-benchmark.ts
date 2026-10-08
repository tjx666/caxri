/**
 * Measures one Claude live-session metadata probe against a synthetic `sessions/` directory holding the 512-file cap
 * (issue #556). Runs below the Electron boundary because the probe is pure filesystem work; `agent.probe` in the
 * production log only surfaces samples above 250ms, so the full distribution needs this dedicated scenario.
 *
 * This is a trend tool, not a gate. It used to exit non-zero above a 50ms warm p95, which never protected anything: a
 * wall-clock threshold moves with machine load, so a cache failing completely and falling back to reading all 512 files
 * still finishes under 50ms on an idle machine, while a loaded one fails a run that changed nothing (issue #630). What
 * does discriminate is the syscall accounting, which is independent of machine speed and is asserted in
 * `metadata-cache.test.ts`, and, for a real run, printed here as the cache counters beside the timings.
 *
 * Usage: `bun run benchmark:agent-probe` (override with `CAXRI_BENCHMARK_AGENT_PROBE_FILES` and
 * `CAXRI_BENCHMARK_AGENT_PROBE_ITERATIONS`).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { claudeProvider } from '../apps/server/src/domains/agents/providers/claude';
import type { ClaudeMetadataCacheCounters } from '../apps/server/src/domains/agents/providers/claude/metadata-cache';
import {
    claudeMetadataCacheCounters,
    clearClaudeMetadataCache,
} from '../apps/server/src/domains/agents/providers/claude/metadata-cache';

export interface AgentProbeBenchmarkResult {
    /**
     * The cache accounting for the whole run, which is what makes the timings readable: a warm p95 means nothing until
     * you know whether those probes were hits.
     */
    cache: ClaudeMetadataCacheCounters;
    coldMs: number;
    files: number;
    iterations: number;
    /**
     * One metadata file is rewritten before every `rewriteEvery`-th warm probe to keep the cache honest.
     */
    rewriteEvery: number;
    warm: { maxMs: number; p50Ms: number; p95Ms: number; p99Ms: number };
}

const DEFAULT_FILES = 512;
const DEFAULT_ITERATIONS = 200;
const REWRITE_EVERY = 10;

function integerEnvironment(name: string, fallback: number): number {
    const value = Number(process.env[name]);
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function percentile(samples: readonly number[], fraction: number): number {
    if (samples.length === 0) return 0;
    const sorted = samples.toSorted((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
    return sorted[Math.max(0, index)] ?? 0;
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

function metadataJson(root: string, index: number, revision: number): string {
    return JSON.stringify({
        cwd: root,
        name: `benchmark-${index}`,
        nameSource: 'derived',
        sessionId: `benchmark-session-${index}`,
        startedAt: new Date(1_700_000_000_000 + index).toISOString(),
        status: revision % 2 === 0 ? 'idle' : 'busy',
        updatedAt: new Date(1_700_000_000_000 + index + revision).toISOString(),
    });
}

export async function runAgentProbeBenchmark(options: {
    files: number;
    iterations: number;
}): Promise<AgentProbeBenchmarkResult> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-probe-benchmark-'));
    try {
        const root = join(directory, 'project');
        const otherRoot = join(directory, 'other-project');
        const config = join(directory, 'claude');
        const sessions = join(config, 'sessions');
        await Promise.all([mkdir(root), mkdir(otherRoot), mkdir(sessions, { recursive: true })]);
        await Promise.all(
            Array.from({ length: options.files }, (_, index) =>
                writeFile(
                    join(sessions, `session-${index}.json`),
                    metadataJson(index % 2 === 0 ? root : otherRoot, index, 0),
                    'utf8',
                ),
            ),
        );
        const environment = { homeDirectory: directory, variables: { CLAUDE_CONFIG_DIR: config } };
        const probe = async (): Promise<number> => {
            const startedAt = performance.now();
            const state = await claudeProvider.readState(
                { processState: 'running', rootPath: root },
                environment,
            );
            if (!state?.sessionId) throw new Error('benchmark probe found no matching session');
            return performance.now() - startedAt;
        };
        clearClaudeMetadataCache();
        const coldMs = await probe();
        const samples: number[] = [];
        for (let iteration = 0; iteration < options.iterations; iteration += 1) {
            if (iteration % REWRITE_EVERY === 0) {
                const index = (iteration / REWRITE_EVERY) % options.files;
                // eslint-disable-next-line no-await-in-loop -- rewrites must land before the probe they precede
                await writeFile(
                    join(sessions, `session-${index}.json`),
                    metadataJson(index % 2 === 0 ? root : otherRoot, index, iteration + 1),
                    'utf8',
                );
            }
            // eslint-disable-next-line no-await-in-loop -- sequential probes measure single-probe latency
            samples.push(await probe());
        }
        return {
            cache: claudeMetadataCacheCounters(),
            coldMs: round(coldMs),
            files: options.files,
            iterations: options.iterations,
            rewriteEvery: REWRITE_EVERY,
            warm: {
                maxMs: round(Math.max(...samples)),
                p50Ms: round(percentile(samples, 0.5)),
                p95Ms: round(percentile(samples, 0.95)),
                p99Ms: round(percentile(samples, 0.99)),
            },
        };
    } finally {
        clearClaudeMetadataCache();
        await rm(directory, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const result = await runAgentProbeBenchmark({
        files: integerEnvironment('CAXRI_BENCHMARK_AGENT_PROBE_FILES', DEFAULT_FILES),
        iterations: integerEnvironment(
            'CAXRI_BENCHMARK_AGENT_PROBE_ITERATIONS',
            DEFAULT_ITERATIONS,
        ),
    });
    console.log(`CAXRI_AGENT_PROBE_BENCHMARK ${JSON.stringify(result)}`);
}

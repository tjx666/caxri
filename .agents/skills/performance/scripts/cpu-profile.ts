/**
 * Samples a running Caxri process's CPU over CDP and prints where the time went, without a relaunch: the Renderer
 * endpoint and every Host inspector are always on (see the `debug` skill). Prints the busy share, the top self-time
 * frames, and the top inclusive functions, which is usually enough to name the owning subsystem of a hot loop.
 *
 * Bun run .agents/skills/performance/scripts/cpu-profile.ts --port 9229 --seconds 10 bun run
 * .agents/skills/performance/scripts/cpu-profile.ts --renderer --port 9224
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';

import type { CdpConnection } from '../../debug/scripts/cdp-client';
import { connectToNodeInspector, connectToRenderer } from '../../debug/scripts/cdp-client';

export interface CpuProfileNode {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    children?: number[];
}

export interface CpuProfile {
    nodes: CpuProfileNode[];
    samples: number[];
}

export interface CpuProfileSummary {
    samples: number;
    busyPercent: number;
    self: Array<{ frame: string; percent: number }>;
    inclusive: Array<{ name: string; percent: number }>;
}

/**
 * Distinct function names from a sample's leaf up to the root, so recursion counts a function once per sample.
 */
function ancestorNames(
    leaf: number,
    nodes: ReadonlyMap<number, CpuProfileNode>,
    parents: ReadonlyMap<number, number>,
): Set<string> {
    const names = new Set<string>();
    for (
        let cursor: number | undefined = leaf;
        cursor !== undefined;
        cursor = parents.get(cursor)
    ) {
        const name = nodes.get(cursor)!.callFrame.functionName;
        if (name && name !== '(root)') names.add(name);
    }
    return names;
}

const IDLE_FRAMES = new Set(['(idle)']);
const round = (value: number): number => Math.round(value * 10) / 10;

/**
 * Self time is keyed by frame (function plus bundle file and line) so identically named closures stay apart; inclusive
 * time is keyed by function name and counted once per sample even when recursion repeats a name up the stack.
 */
export function summarizeCpuProfile(profile: CpuProfile, limit = 15): CpuProfileSummary {
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const parents = new Map<number, number>();
    for (const node of profile.nodes) {
        const children = node.children ?? [];
        for (const child of children) parents.set(child, node.id);
    }
    const hits = new Map<number, number>();
    for (const sample of profile.samples) hits.set(sample, (hits.get(sample) ?? 0) + 1);
    const total = Math.max(1, profile.samples.length);
    const self = new Map<string, number>();
    const inclusive = new Map<string, number>();
    let idle = 0;
    for (const [id, count] of hits) {
        const frame = nodes.get(id)!.callFrame;
        const name = frame.functionName || '(anonymous)';
        if (IDLE_FRAMES.has(name)) idle += count;
        const key = frame.url
            ? `${name} ${frame.url.split('/').pop()}:${frame.lineNumber + 1}`
            : name;
        self.set(key, (self.get(key) ?? 0) + count);
        for (const ancestor of ancestorNames(id, nodes, parents))
            inclusive.set(ancestor, (inclusive.get(ancestor) ?? 0) + count);
    }
    const top = (map: Map<string, number>) =>
        [...map].toSorted((left, right) => right[1] - left[1]).slice(0, limit);
    return {
        samples: profile.samples.length,
        busyPercent: round(((total - idle) / total) * 100),
        self: top(self).map(([frame, count]) => ({ frame, percent: round((count / total) * 100) })),
        inclusive: top(inclusive).map(([name, count]) => ({
            name,
            percent: round((count / total) * 100),
        })),
    };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            port: { type: 'string', default: '9229' },
            seconds: { type: 'string', default: '10' },
            renderer: { type: 'boolean', default: false },
            json: { type: 'boolean', default: false },
        },
    });
    const port = Number(values.port);
    const connection: CdpConnection = values.renderer
        ? await connectToRenderer(port)
        : await connectToNodeInspector(port);
    try {
        await connection.request('Profiler.enable');
        await connection.request('Profiler.setSamplingInterval', { interval: 1000 });
        await connection.request('Profiler.start');
        await sleep(Number(values.seconds) * 1000);
        const { profile } = await connection.request<{ profile: CpuProfile }>('Profiler.stop');
        const summary = summarizeCpuProfile(profile);
        if (values.json) {
            console.log(JSON.stringify(summary, null, 2));
            return;
        }
        console.log(`samples=${summary.samples} busy=${summary.busyPercent}%`);
        console.log('-- self');
        for (const entry of summary.self)
            console.log(`${entry.percent.toFixed(1).padStart(5)}  ${entry.frame}`);
        console.log('-- inclusive');
        for (const entry of summary.inclusive)
            console.log(`${entry.percent.toFixed(1).padStart(5)}  ${entry.name}`);
    } finally {
        connection.close();
    }
}

if (import.meta.main) await main();

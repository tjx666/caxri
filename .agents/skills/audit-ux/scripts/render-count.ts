/**
 * Counts Renderer renders per component instance in a running unpackaged Caxri instance, for the `audit-ux` render
 * evidence layer. It reports counts and mounts only: `docs/renderer-performance.md` forbids ranking components by
 * subtree-inclusive Fiber durations, so no timing is collected here.
 *
 * The instance must be launched with `CAXRI_REACT_SCAN=1` so `virtual:caxri-react-scan-boot` installs the React
 * DevTools hook before react-dom evaluates. See `../references/render-layer.md` for the full procedure.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';

import type { CdpConnection } from '../../debug/scripts/cdp-client';
import { connectToRenderer } from '../../debug/scripts/cdp-client';
import type { RenderCountOptions } from './render-count-options';
import { HELP, parseRenderCountOptions } from './render-count-options';

const POLL_INTERVAL_MS = 250;
const EVALUATE_TIMEOUT_MS = 30_000;

export interface RenderInstanceRow {
    firstMs: number;
    hidden: boolean;
    instance: number;
    lastMs: number;
    mounts: number;
    name: string;
    updates: number;
    /**
     * Whether the instance is the `--within` component or renders beneath it. Absent when no scope was requested.
     */
    within?: boolean;
}

export interface RenderSample {
    armed: boolean;
    collectorError: string | null;
    /**
     * Raw render callbacks the page counted, including unmount phases that no row column attributes. The table's
     * `commits` is the sum of mounts and updates instead, so the two can differ; this one only drives settling.
     */
    commits: number;
    /**
     * Whether the sampled window's product root (the Workbench, or Caxri Bot) rendered.
     */
    isWindowReady: boolean;
    rows: RenderInstanceRow[];
    settled: boolean;
    windowMs: number;
}

export interface RenderSummary {
    commits: number;
    hiddenInstances: number;
    instances: number;
    mounts: number;
    repeatedComponents: Array<{
        firstMs: [number, number];
        instances: number;
        name: string;
    }>;
    rows: RenderInstanceRow[];
    updates: number;
}

/**
 * Ranks by total renders, then by mounts, so a remount wave outranks an equally busy update wave.
 *
 * Repeated component names are reported separately with the first-render window of their instances, because that window
 * is what separates the two meanings: 49 `FileTreeItem` instances that all start together are one list, while two
 * instances of a provider starting seconds apart mean the tree below some ancestor was torn down and rebuilt, which no
 * amount of render-count tuning fixes. Widest window first.
 */
export function summarizeRenderSample(rows: RenderInstanceRow[]): RenderSummary {
    const ranked = rows.toSorted(
        (left, right) =>
            right.mounts + right.updates - (left.mounts + left.updates) ||
            right.mounts - left.mounts ||
            left.name.localeCompare(right.name) ||
            left.instance - right.instance,
    );
    const startsByName = new Map<string, number[]>();
    for (const row of rows) {
        const starts = startsByName.get(row.name) ?? [];
        starts.push(row.firstMs);
        startsByName.set(row.name, starts);
    }
    return {
        commits: rows.reduce((total, row) => total + row.mounts + row.updates, 0),
        hiddenInstances: rows.filter((row) => row.hidden).length,
        instances: rows.length,
        mounts: rows.reduce((total, row) => total + row.mounts, 0),
        repeatedComponents: [...startsByName]
            .filter(([, starts]) => starts.length > 1)
            .map(([name, starts]) => ({
                firstMs: [Math.min(...starts), Math.max(...starts)] as [number, number],
                instances: starts.length,
                name,
            }))
            .toSorted(
                (left, right) =>
                    right.firstMs[1] - right.firstMs[0] - (left.firstMs[1] - left.firstMs[0]) ||
                    right.instances - left.instances,
            )
            .slice(0, 20),
        rows: ranked,
        updates: rows.reduce((total, row) => total + row.updates, 0),
    };
}

/**
 * Splits one sample into the `--within` surface and the whole window, so both numbers describe the same interaction.
 */
export function scopeRenderSample(
    rows: RenderInstanceRow[],
    within: string | undefined,
): { scoped: RenderSummary; window?: RenderSummary } {
    if (!within) return { scoped: summarizeRenderSample(rows) };
    return {
        scoped: summarizeRenderSample(rows.filter((row) => row.within === true)),
        window: summarizeRenderSample(rows),
    };
}

export function formatRenderTable(
    summary: RenderSummary,
    sample: Pick<RenderSample, 'settled' | 'windowMs'>,
    {
        label,
        limit,
        scope,
    }: { label: string; limit: number; scope?: { name: string; window: RenderSummary } },
): string {
    const scopeHeader = scope
        ? ` within=${scope.name} (window: instances=${scope.window.instances} commits=${scope.window.commits} mounts=${scope.window.mounts} updates=${scope.window.updates})`
        : '';
    const lines = [
        `scenario=${label} windowMs=${sample.windowMs} settled=${sample.settled ? 'yes' : 'no'} instances=${summary.instances} commits=${summary.commits} mounts=${summary.mounts} updates=${summary.updates} hidden=${summary.hiddenInstances}${scopeHeader}`,
        'mounts\tupdates\tfirstMs\tlastMs\thidden\tinstance',
    ];
    for (const row of summary.rows.slice(0, limit)) {
        lines.push(
            `${row.mounts}\t${row.updates}\t${row.firstMs}\t${row.lastMs}\t${row.hidden ? 'yes' : 'no'}\t${row.name}#${row.instance}`,
        );
    }
    if (summary.rows.length > limit) {
        lines.push(`… ${summary.rows.length - limit} more instances (use --json for all)`);
    }
    if (summary.repeatedComponents.length > 0) {
        lines.push(
            `repeated components (name×instances@firstMs): ${summary.repeatedComponents
                .map(
                    ({ firstMs, instances, name }) =>
                        `${name}×${instances}@${firstMs[0]}-${firstMs[1]}`,
                )
                .join(' ')}`,
        );
    }
    return lines.join('\n');
}

/**
 * The in-page collector. It keys rows by fiber instance rather than by component name: aggregating by name inflates
 * counts, can make a child look busier than its parent, and hides the most important boot finding of all: the same
 * component mounted twice.
 *
 * Installing is idempotent and arming resets the counters, because react-scan keeps one instrumentation per document
 * (`isInstrumentationInitialized`). A second measurement in the same window must therefore reuse the already registered
 * `onRender` closure; replacing the state object instead would leave every later render counted into an orphan and
 * report zero. For the same reason a collector left over from an older build of this script cannot be swapped in place;
 * it is marked stale so `sample` fails loudly instead of reporting one window's counts under another window's
 * semantics.
 *
 * Only component names, counts, and timestamps leave the page. Never add DOM text, prop values, or paths here: this
 * output is pasted into audit reports.
 */
const COLLECTOR_SOURCE = `
(() => {
  const VERSION = 1;
  const installed = globalThis.__CAXRI_RENDER_AUDIT__;
  if (installed) {
    if (installed.version !== VERSION) installed.stale = true;
    return;
  }
  const state = {
    armed: false,
    collectorError: null,
    commits: 0,
    rows: new Map(),
    stale: false,
    startedAt: 0,
    version: VERSION,
  };
  const ids = new WeakMap();
  const sequence = { next: 1 };
  const identify = (fiber) => {
    let id = ids.get(fiber);
    if (id === undefined && fiber.alternate) id = ids.get(fiber.alternate);
    if (id === undefined) id = sequence.next++;
    ids.set(fiber, id);
    // Alternates are the two halves of one instance; sharing an id keeps update counts on a single row.
    if (fiber.alternate) ids.set(fiber.alternate, id);
    return id;
  };
  const describe = (fiber) => {
    const type = fiber.type;
    if (typeof type === 'string') return type;
    return (
      type?.displayName || type?.name || type?.render?.displayName || type?.render?.name || 'anonymous'
    );
  };
  state.onRender = (fiber, renders) => {
    try {
      const name = describe(fiber);
      const instance = identify(fiber);
      const key = name + '#' + instance;
      let row = state.rows.get(key);
      if (!row) {
        row = {
          fiber,
          firstMs: Date.now() - state.startedAt,
          instance,
          mounts: 0,
          name,
          updates: 0,
        };
        state.rows.set(key, row);
      }
      for (const render of renders) {
        state.commits++;
        // RenderPhase: 1 = Mount, 2 = Update, 4 = Unmount.
        if (render.phase === 1) row.mounts++;
        else if (render.phase === 2) row.updates++;
      }
      row.lastMs = Date.now() - state.startedAt;
    } catch (error) {
      state.collectorError = String(error);
    }
  };
  state.reset = () => {
    state.rows.clear();
    state.commits = 0;
    state.collectorError = null;
    state.startedAt = Date.now();
  };
  state.arm = (scan) => {
    state.reset();
    if (state.armed) return;
    state.armed = true;
    try {
      /**
       * The boot module calls scan({ enabled: false }), and setOptions persists that into
       * localStorage['react-scan-options']. react-scan's start() merges the stored options back over the ones passed
       * here, so without this removal the instrumentation stays paused and every count silently comes back zero.
       */
      localStorage.removeItem('react-scan-options');
      scan({
        animationSpeed: 'off',
        enabled: true,
        onRender: state.onRender,
        showToolbar: false,
        // The Renderer CSP has no worker-src blob:, so the offscreen-canvas worker would be rejected.
        useOffscreenCanvasWorker: false,
      });
    } catch (error) {
      state.armed = false;
      state.collectorError = String(error);
    }
  };
  globalThis.__CAXRI_RENDER_AUDIT__ = state;
})();
`;

const BOOT_ARM_SOURCE = `${COLLECTOR_SOURCE}
(() => {
  const state = globalThis.__CAXRI_RENDER_AUDIT__;
  let current;
  // Arming has to happen the moment the boot module publishes scan(), which is still before react-dom evaluates.
  Object.defineProperty(globalThis, '__CAXRI_REACT_SCAN__', {
    configurable: true,
    get: () => current,
    set: (next) => {
      current = next;
      if (next && typeof next.scan === 'function') state.arm(next.scan);
    },
  });
})();
`;

const LIVE_ARM_SOURCE = `${COLLECTOR_SOURCE}
(() => {
  const scan = globalThis.__CAXRI_REACT_SCAN__?.scan;
  if (typeof scan !== 'function') {
    return 'MISSING_ARMING: relaunch the instance with CAXRI_REACT_SCAN=1';
  }
  const state = globalThis.__CAXRI_RENDER_AUDIT__;
  if (state.stale) {
    return 'STALE_COLLECTOR: this window holds an older collector; run the boot command once to reload it';
  }
  state.arm(scan);
  return 'ARMED';
})();
`;

const PROGRESS_SOURCE = `
(() => {
  const state = globalThis.__CAXRI_RENDER_AUDIT__;
  return JSON.stringify({
    commits: state ? state.commits : -1,
    ready: Boolean(document.querySelector('.workbench')),
  });
})();
`;

/**
 * Builds the report expression. `within` is matched by walking each instance's `return` chain for a component of that
 * name, so the scope follows React's tree rather than the DOM: a portal (a menu or tooltip popup) still counts toward
 * the Session row that rendered it, which is where its update cost comes from.
 */
function reportSource(within: string | undefined): string {
    return `
(() => {
  const state = globalThis.__CAXRI_RENDER_AUDIT__;
  if (!state) return JSON.stringify({ missing: true });
  const within = ${JSON.stringify(within ?? null)};
  const nameOf = (fiber) => {
    const type = fiber.type;
    if (typeof type === 'string') return type;
    return type?.displayName || type?.name || type?.render?.displayName || type?.render?.name || '';
  };
  const isWithin = (fiber) => {
    let node = fiber;
    let guard = 0;
    while (node && guard++ < 2000) {
      if (nameOf(node) === within) return true;
      node = node.return;
    }
    return false;
  };
  const elementOf = (fiber) => {
    let node = fiber;
    let guard = 0;
    while (node && guard++ < 40) {
      if (node.stateNode instanceof Element) return node.stateNode;
      node = node.child;
    }
    return null;
  };
  const rows = [];
  for (const row of state.rows.values()) {
    const element = elementOf(row.fiber);
    const box = element?.getBoundingClientRect();
    rows.push({
      firstMs: row.firstMs,
      hidden: element
        ? box.width === 0 || box.height === 0 || element.isConnected === false
        : false,
      instance: row.instance,
      lastMs: row.lastMs ?? row.firstMs,
      mounts: row.mounts,
      name: row.name,
      updates: row.updates,
      ...(within === null ? {} : { within: row.fiber ? isWithin(row.fiber) : false }),
    });
    // Release the audit's fiber references so a sampled subtree cannot be retained after the report.
    row.fiber = null;
  }
  return JSON.stringify({
    armed: state.armed,
    collectorError: state.collectorError,
    commits: state.commits,
    windowMs: state.startedAt ? Date.now() - state.startedAt : 0,
    // A --url sample can target the Caxri Bot window, whose root replaces the Workbench.
    isWindowReady: Boolean(document.querySelector('.workbench, .caxri-bot')),
    rows,
  });
})();
`;
}

async function evaluate<T>(client: CdpConnection, expression: string): Promise<T> {
    const response = await client.request<{
        exceptionDetails?: { text: string };
        result: { value?: T };
    }>(
        'Runtime.evaluate',
        { awaitPromise: true, expression, returnByValue: true },
        EVALUATE_TIMEOUT_MS,
    );
    if (response.exceptionDetails) {
        throw new Error(`Renderer evaluation failed: ${response.exceptionDetails.text}`);
    }
    return response.result.value as T;
}

/**
 * Waits for the render storm to finish instead of cutting the window at a fixed length. A Session switch reaches the
 * Renderer only after a Server round trip, so a fixed short window reported zero renders for a switch whose work simply
 * had not arrived yet, a false "this interaction is free". Returns whether the sample actually went quiet.
 *
 * A boot sample additionally may not settle before the Workbench exists: startup has quiet gaps while it waits on the
 * Server, and settling inside one of them would describe the loading shell.
 */
async function didSampleSettle(
    client: CdpConnection,
    options: RenderCountOptions,
): Promise<boolean> {
    const deadline = Date.now() + options.seconds * 1000;
    let lastCommits = -1;
    let lastChangeAt = Date.now();
    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        // eslint-disable-next-line no-await-in-loop
        const raw = await evaluate<string>(client, PROGRESS_SOURCE);
        const { commits, ready } = JSON.parse(raw) as { commits: number; ready: boolean };
        const isWaitingForWorkbench = !ready && options.command === 'boot';
        if (isWaitingForWorkbench || commits !== lastCommits) {
            lastCommits = commits;
            lastChangeAt = Date.now();
            continue;
        }
        if (commits > 0 && Date.now() - lastChangeAt >= options.settleMs) return true;
    }
    return false;
}

/**
 * Moves the real mouse to the element's center and waits for a hover card to be open, so Base UI's hover timers and
 * hand-off logic run exactly as they do for a user. A synthetic `.click()` cannot reproduce them.
 */
async function hoverElement(client: CdpConnection, selector: string): Promise<void> {
    const point = await evaluate<string>(
        client,
        `(() => {
            const target = document.querySelector(${JSON.stringify(selector)});
            if (!target) return 'MISSING_TARGET';
            const box = target.getBoundingClientRect();
            return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
        })()`,
    );
    if (point === 'MISSING_TARGET') throw new Error(`No element matched hover target ${selector}`);
    const { x, y } = JSON.parse(point) as { x: number; y: number };
    await client.request('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        // eslint-disable-next-line no-await-in-loop
        const isOpen = await evaluate<boolean>(
            client,
            `Boolean(document.querySelector('[data-slot="hover-card-content"][data-open]'))`,
        );
        if (isOpen) return;
    }
    throw new Error(`No hover card opened for ${selector}`);
}

export async function collectRenderSample(
    options: RenderCountOptions,
    connect = connectToRenderer,
): Promise<RenderSample> {
    const client = await connect(options.port, options.url);
    /**
     * Set for `boot`, so the arming script can be withdrawn again and only this one reload is instrumented.
     */
    let bootScriptId: string | undefined;
    try {
        await client.request('Page.enable');
        await client.request('Runtime.enable');
        if (options.command === 'boot') {
            const added = await client.request<{ identifier: string }>(
                'Page.addScriptToEvaluateOnNewDocument',
                { source: BOOT_ARM_SOURCE },
            );
            bootScriptId = added.identifier;
            await client.request('Page.reload', { ignoreCache: false });
        } else {
            if (options.prehover) await hoverElement(client, options.prehover);
            await new Promise<void>((resolve) => setTimeout(resolve, options.prehover ? 800 : 0));
            const armed = await evaluate<string>(client, LIVE_ARM_SOURCE);
            if (armed !== 'ARMED') throw new Error(armed);
            if (options.hover) await hoverElement(client, options.hover);
            if (options.click) {
                const clicked = await evaluate<string>(
                    client,
                    `(() => {
                        const target = document.querySelector(${JSON.stringify(options.click)});
                        if (!target) return 'MISSING_TARGET';
                        target.click();
                        return 'CLICKED';
                    })()`,
                );
                if (clicked !== 'CLICKED') {
                    throw new Error(`No element matched --click ${options.click}`);
                }
            }
        }
        const settled = await didSampleSettle(client, options);
        const raw = await evaluate<string>(client, reportSource(options.within));
        const parsed = JSON.parse(raw) as Omit<RenderSample, 'settled'> & { missing?: boolean };
        if (parsed.missing) throw new Error('The render collector is not installed in this window');
        if (!parsed.armed) {
            throw new Error(
                `The render collector never armed${parsed.collectorError ? `: ${parsed.collectorError}` : '; relaunch with CAXRI_REACT_SCAN=1'}`,
            );
        }
        return { ...parsed, settled };
    } finally {
        if (bootScriptId) {
            try {
                await client.request('Page.removeScriptToEvaluateOnNewDocument', {
                    identifier: bootScriptId,
                });
            } catch {
                // A closed window cannot be cleaned up, and must not mask the sample's own failure.
            }
        }
        client.close();
    }
}

async function main(): Promise<void> {
    const options = parseRenderCountOptions(process.argv.slice(2));
    if (options === 'help') {
        console.log(HELP);
        return;
    }
    const sample = await collectRenderSample(options);
    const { scoped: summary, window } = scopeRenderSample(sample.rows, options.within);
    if (options.json) {
        await mkdir(dirname(options.json), { recursive: true });
        await writeFile(
            options.json,
            `${JSON.stringify(
                {
                    label: options.label,
                    settled: sample.settled,
                    summary,
                    ...(options.within && { within: options.within, window }),
                    windowMs: sample.windowMs,
                },
                null,
                2,
            )}\n`,
            'utf8',
        );
    }
    console.log(
        formatRenderTable(summary, sample, {
            ...options,
            ...(options.within && window && { scope: { name: options.within, window } }),
        }),
    );
    if (sample.collectorError) console.error(`collector error: ${sample.collectorError}`);
    if (!sample.isWindowReady) {
        throw new Error(
            'The window never rendered its product root during this sample; the counts describe the loading shell, not the product',
        );
    }
    // A scoped surface that stayed still is a result, not a missed click, so only the whole window proves the click.
    if ((window ?? summary).commits === 0) {
        throw new Error(
            'No render was recorded, which means the interaction never reached React: check the --click target instead of reporting the scenario as free',
        );
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

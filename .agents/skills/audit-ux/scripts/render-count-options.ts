/**
 * Command-line options of `render-count.ts`: the usage text, the option shape, and its parser.
 */
import { resolve } from 'node:path';
import process from 'node:process';

const DEFAULT_PORT = 9233;
const MAX_SAMPLE_SECONDS = 120;
const DEFAULT_MAX_SECONDS = 20;
const DEFAULT_SETTLE_MS = 1500;
const DEFAULT_TABLE_LIMIT = 30;

export const HELP = `Count Caxri Renderer renders per component instance over CDP.

Usage:
  render-count.ts boot   [--port PORT] [--url SUBSTRING] [--label NAME] [--seconds ${DEFAULT_MAX_SECONDS}] [--settle-ms ${DEFAULT_SETTLE_MS}] [--limit ${DEFAULT_TABLE_LIMIT}] [--json FILE]
  render-count.ts sample [--port PORT] [--url SUBSTRING] [--label NAME] [--click SELECTOR] [--within COMPONENT] [--seconds ${DEFAULT_MAX_SECONDS}] [--settle-ms ${DEFAULT_SETTLE_MS}] [--limit ${DEFAULT_TABLE_LIMIT}] [--json FILE]

  boot    reloads the window with the collector armed before any page script, so the first-paint storm is measured.
  sample  arms the collector on the loaded window and counts what the scenario causes.

A sample ends once no render has arrived for --settle-ms, or when --seconds runs out. An interaction that reaches the
Renderer only after a Server round trip is therefore measured to completion instead of being cut off at a fixed
window, and a run that never went quiet is reported as unsettled.

Options:
  --port       CDP port of the dev instance (default ${DEFAULT_PORT}; CAXRI_DEV_CDP_PORT sets it at launch).
  --url        Substring of the window URL to measure, e.g. "caxri-bot" (default: the main window).
  --label      Scenario name recorded in the report, e.g. "session-switch".
  --click      CSS selector clicked once right after arming, for a single-interaction scenario.
  --within     Component name, e.g. "PrimarySidebar": the table keeps only instances that are that component or render
               beneath it, and the header adds the whole-window totals of the same interaction for comparison.
  --seconds    Upper bound on the sample window (1-${MAX_SAMPLE_SECONDS}).
  --settle-ms  Quiet period that ends the sample (100-30000).
  --limit      Rows printed in the table (the JSON report always keeps every instance).
  --json       Write the full report as JSON to this path.
`;

export interface RenderCountOptions {
    click?: string;
    command: 'boot' | 'sample';
    json?: string;
    label: string;
    limit: number;
    port: number;
    seconds: number;
    settleMs: number;
    /**
     * Substring of the CDP target URL, for a secondary window such as Caxri Bot. Absent: the main window.
     */
    url?: string;
    /**
     * Component name that scopes the table to one surface's subtree. The whole-window totals of the same interaction
     * are still reported beside it, so a surface's share is read from one sample instead of two different clicks.
     */
    within?: string;
}

function requiredValue(argv: string[], index: number, option: string): string {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
    return value;
}

function boundedInteger(raw: string, option: string, minimum: number, maximum: number): number {
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new Error(`${option} must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
}

const ALLOWED_OPTIONS = new Set([
    '--click',
    '--json',
    '--label',
    '--limit',
    '--port',
    '--seconds',
    '--settle-ms',
    '--url',
    '--within',
]);

export function parseRenderCountOptions(argv: string[]): RenderCountOptions | 'help' {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) return 'help';
    const command = argv[0];
    if (command !== 'boot' && command !== 'sample') {
        throw new Error(`Unknown command: ${command}; expected boot or sample`);
    }
    const values = new Map<string, string>();
    // Every option takes a value, so arguments are read in pairs like the neighboring capture script.
    for (let index = 1; index < argv.length; index += 2) {
        const option = argv[index];
        if (!ALLOWED_OPTIONS.has(option)) throw new Error(`Unknown option: ${option}`);
        values.set(option, requiredValue(argv, index, option));
    }
    const click = values.get('--click');
    if (command === 'boot' && click) {
        throw new Error('--click needs a loaded window; use the sample command');
    }
    const json = values.get('--json');
    const options: RenderCountOptions = {
        command,
        label: values.get('--label') ?? command,
        limit: boundedInteger(
            values.get('--limit') ?? String(DEFAULT_TABLE_LIMIT),
            '--limit',
            1,
            500,
        ),
        port: boundedInteger(values.get('--port') ?? String(DEFAULT_PORT), '--port', 1, 65_535),
        seconds: boundedInteger(
            values.get('--seconds') ?? String(DEFAULT_MAX_SECONDS),
            '--seconds',
            1,
            MAX_SAMPLE_SECONDS,
        ),
        settleMs: boundedInteger(
            values.get('--settle-ms') ?? String(DEFAULT_SETTLE_MS),
            '--settle-ms',
            100,
            30_000,
        ),
    };
    if (click) options.click = click;
    if (json) options.json = resolve(process.cwd(), json);
    const within = values.get('--within');
    if (within) options.within = within;
    const url = values.get('--url');
    if (url) options.url = url;
    return options;
}

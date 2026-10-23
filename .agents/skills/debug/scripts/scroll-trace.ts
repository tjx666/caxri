/**
 * Traces how Agent Chat transcripts (`[role="log"]` scrollers) move, to find a scroll the user did not make that still
 * revealed the overlay scrollbar. The recorder is content-free: offsets, sizes, whether the scrollbar was hidden, the
 * calling function of a programmatic scroll, and the tag, data attribute names, and first classes of a row that
 * resized. It never reads text, so it may run against the installed app (`--packaged`) while the user reproduces.
 *
 * Usage: `bun run .agents/skills/debug/scripts/scroll-trace.ts <start|read|reset> [--packaged] [--json]`
 *
 * - `start` installs the recorder; a reload or relaunch removes it, so install it again after either.
 * - `read` prints the trace. `REVEAL` marks a scroll event that ran with the scrollbar visible and no user input in the
 *   previous {@link USER_INPUT_WINDOW_MS} ms: the flash a user reports as the view scrolling by itself.
 * - `reset` clears the recorded entries and keeps recording.
 */
import process from 'node:process';

import { execFileAsync } from '../../../../scripts/exec';
import { CommandError } from '../../switch-worktree/scripts/process';
import { browserArguments, verifiedTarget } from './worktree-browser';

const ACTIONS = ['start', 'read', 'reset'] as const;
type Action = (typeof ACTIONS)[number];

/**
 * A scroll this soon after a wheel, key, pointer, or touch input counts as the user's.
 */
const USER_INPUT_WINDOW_MS = 200;

export type ScrollTraceEntry =
    /**
     * A `scroll` event on a transcript.
     */
    | {
          kind: 'scroll';
          t: number;
          top: number;
          hidden: boolean;
          sinceInput: number | null;
          scrollHeight: number;
          clientHeight: number;
      }
    /**
     * A programmatic scroll: a `scrollTop` write, `scrollTo`, `scrollBy`, or `scrollIntoView`.
     */
    | {
          kind: 'write';
          t: number;
          call: string;
          from: number;
          to: number;
          hidden: boolean;
          caller: string;
      }
    /**
     * A row inside a transcript changing height.
     */
    | { kind: 'resize'; t: number; row: string; from: number; to: number; top: number };

/**
 * Runs inside the Renderer. Kept as source text because the script's TypeScript project has no DOM library.
 */
const RECORDER = String.raw`(() => {
  if (globalThis.__caxriScrollTrace) return 'already installed';
  const LIMIT = 2000;
  const entries = [];
  const push = (entry) => { if (entries.length < LIMIT) entries.push(entry); };
  const now = () => Math.round(performance.now());
  let lastInput;
  for (const type of ['wheel', 'keydown', 'pointerdown', 'touchstart'])
    addEventListener(type, () => { lastInput = performance.now(); }, { capture: true, passive: true });
  const logOf = (element) => element?.closest?.('[role="log"]') ?? null;
  const isLog = (element) => element?.getAttribute?.('role') === 'log';
  const hidden = (element) => element.style.scrollbarWidth === 'none';
  const caller = () => (new Error().stack ?? '').split('\n')[3]?.trim().replace(/^at /, '').replace(/\s*\(.*$/, '') ?? '';
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get() { return descriptor.get.call(this); },
    set(value) {
      if (!isLog(this)) return descriptor.set.call(this, value);
      const from = descriptor.get.call(this);
      descriptor.set.call(this, value);
      const to = descriptor.get.call(this);
      if (Math.abs(to - from) >= 1) push({ kind: 'write', t: now(), call: 'scrollTop', from: Math.round(from), to: Math.round(to), hidden: hidden(this), caller: caller() });
    },
  });
  for (const name of ['scrollTo', 'scrollBy', 'scrollIntoView']) {
    const original = Element.prototype[name];
    Element.prototype[name] = function (...args) {
      const log = name === 'scrollIntoView' ? logOf(this) : isLog(this) ? this : null;
      if (!log) return original.apply(this, args);
      const from = log.scrollTop;
      const result = original.apply(this, args);
      push({ kind: 'write', t: now(), call: name, from: Math.round(from), to: Math.round(log.scrollTop), hidden: hidden(log), caller: caller() });
      return result;
    };
  }
  addEventListener('scroll', (event) => {
    const element = event.target;
    if (!isLog(element)) return;
    push({ kind: 'scroll', t: now(), top: Math.round(element.scrollTop), hidden: hidden(element), sinceInput: lastInput === undefined ? null : Math.round(performance.now() - lastInput), scrollHeight: element.scrollHeight, clientHeight: element.clientHeight });
  }, true);
  const describe = (element) => {
    const parts = [];
    for (let node = element, depth = 0; node && !isLog(node) && depth < 2; node = node.parentElement, depth++) {
      const data = Object.keys(node.dataset ?? {}).join(',');
      parts.push(node.tagName.toLowerCase() + (data ? '[' + data + ']' : '') + '.' + String(node.className).split(' ').slice(0, 2).join('.'));
    }
    return parts.join(' < ');
  };
  const heights = new WeakMap();
  const rows = new ResizeObserver((records) => {
    for (const record of records) {
      const log = logOf(record.target);
      if (!log) continue;
      const height = Math.round(record.contentRect.height);
      const previous = heights.get(record.target);
      heights.set(record.target, height);
      if (previous !== undefined && previous !== height) push({ kind: 'resize', t: now(), row: describe(record.target), from: previous, to: height, top: Math.round(log.scrollTop) });
    }
  });
  const observed = new WeakSet();
  const watch = () => {
    for (const log of document.querySelectorAll('[role="log"]'))
      for (const row of log.querySelectorAll(':scope > * > *, :scope > * > * > *'))
        if (!observed.has(row)) { observed.add(row); rows.observe(row); }
  };
  watch();
  new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
  globalThis.__caxriScrollTrace = entries;
  return 'installed';
})()`;

export function parseScrollTraceCommand(argv: string[]): {
    action: Action;
    isJson: boolean;
    isPackaged: boolean;
} {
    const flags = new Set(argv.filter((value) => value.startsWith('--')));
    const positional = argv.filter((value) => !value.startsWith('--'));
    for (const flag of flags) {
        if (flag !== '--packaged' && flag !== '--json') {
            throw new CommandError(`Unknown option ${flag}`, 2);
        }
    }
    const [action, ...rest] = positional;
    if (!ACTIONS.includes(action as Action) || rest.length > 0) {
        throw new CommandError(`Pass one action: ${ACTIONS.join(', ')}`, 2);
    }
    return {
        action: action as Action,
        isJson: flags.has('--json'),
        isPackaged: flags.has('--packaged'),
    };
}

/**
 * A scroll event that showed the scrollbar although the user did not scroll.
 */
export function isUnexpectedReveal(entry: ScrollTraceEntry): boolean {
    return (
        entry.kind === 'scroll' &&
        !entry.hidden &&
        (entry.sinceInput === null || entry.sinceInput > USER_INPUT_WINDOW_MS)
    );
}

export function formatScrollTrace(entries: readonly ScrollTraceEntry[]): string {
    if (entries.length === 0) return 'No transcript scrolls recorded yet.';
    const start = entries[0].t;
    const lines = entries.map((entry) => {
        const at = `+${String(entry.t - start).padStart(6)}ms`;
        switch (entry.kind) {
            case 'scroll':
                return `${at} ${isUnexpectedReveal(entry) ? 'REVEAL' : 'scroll'} top=${entry.top} scrollbar=${entry.hidden ? 'hidden' : 'shown'} sinceInput=${entry.sinceInput ?? '-'} height=${entry.scrollHeight}/${entry.clientHeight}`;
            case 'write':
                return `${at} write  ${entry.call} ${entry.from}->${entry.to} scrollbar=${entry.hidden ? 'hidden' : 'shown'} by ${entry.caller || '?'}`;
            default:
                return `${at} resize ${entry.from}->${entry.to} top=${entry.top} ${entry.row}`;
        }
    });
    const reveals = entries.filter(isUnexpectedReveal).length;
    lines.push(`${reveals} unexpected scrollbar reveal(s) in ${entries.length} entries`);
    return lines.join('\n');
}

/**
 * `agent-browser eval` prints the evaluated value as JSON, and the expression stringifies once more.
 */
export function parseEvalJson(output: string): unknown {
    const outer: unknown = JSON.parse(output.trim());
    return typeof outer === 'string' ? JSON.parse(outer) : outer;
}

async function main(): Promise<void> {
    const command = parseScrollTraceCommand(process.argv.slice(2));
    const { cwd, environment, target } = await verifiedTarget(process.cwd(), command.isPackaged);
    const evaluate = async (expression: string): Promise<unknown> => {
        const { stdout } = await execFileAsync(
            'agent-browser',
            browserArguments(target, ['eval', expression]),
            { cwd, encoding: 'utf8', env: environment },
        );
        return parseEvalJson(stdout);
    };
    switch (command.action) {
        case 'start':
            process.stdout.write(`${String(await evaluate(`JSON.stringify(${RECORDER})`))}\n`);
            return;
        case 'reset':
            await evaluate(
                'JSON.stringify(globalThis.__caxriScrollTrace ? (globalThis.__caxriScrollTrace.length = 0) : -1)',
            );
            return;
        case 'read': {
            const entries = await evaluate('JSON.stringify(globalThis.__caxriScrollTrace ?? null)');
            if (entries === null) {
                throw new CommandError(
                    'No recorder in this window; run `start` again after a reload',
                );
            }
            process.stdout.write(
                command.isJson
                    ? `${JSON.stringify(entries)}\n`
                    : `${formatScrollTrace(entries as ScrollTraceEntry[])}\n`,
            );
        }
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = error instanceof CommandError ? error.exitCode : 1;
    }
}

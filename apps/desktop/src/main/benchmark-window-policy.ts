import { CaxriError, methodFromEnvelope } from '@caxri/protocol';

/**
 * Requests the Benchmark window may send. Its own surface is the `benchmark.*` methods; the rest is what the shared
 * Renderer shell reads to look like the Workbench (`settings.get`, `theme.get`, `window.fullScreen.get`) and recover
 * its event stream (`events.recover`), plus what the Markdown in an Attempt's answer may ask for (`external.open`,
 * `links.preview`, `links.favicon`, `projectStatus.linearIssue`). `app.bootstrap` is admitted because the window
 * renders from the Workbench snapshot: its locale, theme, and the Project list the New run form offers. It shares the
 * Workbench's Desktop principal, so this list is its only authority boundary; anything that edits files, Projects,
 * Sessions, Settings, or a Terminal is absent.
 */
const ADMITTED_METHODS = new Set<string>([
    'app.bootstrap',
    'benchmark.attemptDiff',
    'benchmark.cancel',
    'benchmark.catalog',
    'benchmark.delete',
    'benchmark.get',
    'benchmark.list',
    'benchmark.shareImage.copy',
    'benchmark.shareImage.save',
    'benchmark.start',
    'clipboard.write',
    'events.recover',
    'external.open',
    'links.favicon',
    'links.preview',
    'projectStatus.linearIssue',
    'settings.get',
    'theme.get',
    'window.fullScreen.get',
]);

/**
 * Transient events the Benchmark window acts on: run progress, and the reconnect notice after which it re-reads
 * everything. Neither is a command, so the Workbench receiving it too runs nothing twice.
 */
const SHARED_TRANSIENT_EVENTS = new Set<string>(['benchmark.changed', 'host.connectionChanged']);

/**
 * Whether `method` is one the Benchmark window may send. Exposed for the unit test.
 */
export function isBenchmarkWindowMethod(method: string): boolean {
    return ADMITTED_METHODS.has(method);
}

/**
 * Throws `FORBIDDEN` (after reporting the method) when the Benchmark window may not send this request envelope.
 */
export function admitBenchmarkWindowRequest(
    raw: unknown,
    onDenied: (method: string | null) => void,
): void {
    const method = methodFromEnvelope(raw);
    if (method && ADMITTED_METHODS.has(method)) return;
    onDenied(method);
    throw new CaxriError('FORBIDDEN', 'The Benchmark window cannot send this request');
}

/**
 * Whether one relay message also goes to the Benchmark window. Durable journal envelopes always do, so its recovering
 * event client sees a gap-free cursor sequence; of the transient ones, only those it acts on. The Workbench keeps
 * receiving every message, so UI commands such as `command.execute` still run exactly once, there.
 */
export function isBenchmarkWindowEvent(message: unknown): boolean {
    // Runs for every PTY chunk, so it reads plain properties instead of parsing a schema.
    if (typeof message !== 'object' || message === null) return false;
    if ('cursor' in message) return true;
    const event: unknown = Reflect.get(message, 'event');
    return typeof event === 'string' && SHARED_TRANSIENT_EVENTS.has(event);
}

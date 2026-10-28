import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_FRAMES = 24;
const MAX_REPORTS = 4;

interface CrashFrame {
    imageIndex?: number;
    imageOffset?: number;
    symbol?: string;
}

/**
 * The content-free part of one macOS `.ips` crash report: the process name, the exception, and the faulting thread's
 * frames by image name and symbol. Paths, registers, environment, and memory are left out, so the summary is safe for a
 * public Actions log. Returns `undefined` for anything that is not a parseable crash report.
 */

export function summarizeCrashReport(text: string): string[] | undefined {
    const newline = text.indexOf('\n');
    if (newline === -1) return undefined;
    let body: unknown;
    try {
        body = JSON.parse(text.slice(newline + 1));
    } catch {
        return undefined;
    }
    if (typeof body !== 'object' || body === null) return undefined;
    const report = body as {
        exception?: { signal?: string; type?: string };
        faultingThread?: number;
        procName?: string;
        threads?: Array<{ frames?: CrashFrame[] }>;
        usedImages?: Array<{ name?: string }>;
    };
    const frames = report.threads?.[report.faultingThread ?? 0]?.frames;
    if (!Array.isArray(frames)) return undefined;
    const imageName = (index: number | undefined): string =>
        (index === undefined ? undefined : report.usedImages?.[index]?.name) ?? '???';
    return [
        `${report.procName ?? 'unknown'}: ${report.exception?.type ?? 'unknown'} (${report.exception?.signal ?? 'unknown'}), thread ${report.faultingThread ?? 0}`,
        ...frames
            .slice(0, MAX_FRAMES)
            .map(
                (frame, index) =>
                    `  ${index} ${imageName(frame.imageIndex)} ${frame.symbol ?? `+${frame.imageOffset ?? 0}`}`,
            ),
    ];
}

/**
 * Prints the faulting stacks of `node` crash reports written since `sinceMs`. A Vitest worker that dies with SIGSEGV
 * leaves only "Worker exited unexpectedly" in the log; the macOS report is the only record of which native module
 * crashed (issue #1418), and the hosted runner is gone once the job ends.
 */

export async function printNodeCrashReports(
    sinceMs: number,
    directory = join(homedir(), 'Library', 'Logs', 'DiagnosticReports'),
): Promise<void> {
    let names: string[];
    try {
        names = await readdir(directory);
    } catch {
        return;
    }
    const recent: string[] = [];
    for (const name of names) {
        if (!/^node[-.].*\.ips$/u.test(name)) continue;
        const path = join(directory, name);
        // eslint-disable-next-line no-await-in-loop -- a handful of reports, read once after a failed run
        if ((await stat(path)).mtimeMs >= sinceMs) recent.push(path);
    }
    for (const path of recent.slice(0, MAX_REPORTS)) {
        // eslint-disable-next-line no-await-in-loop -- printed in order, one report at a time
        const summary = summarizeCrashReport(await readFile(path, 'utf8'));
        if (summary) console.log(['Native crash report:', ...summary].join('\n'));
    }
}

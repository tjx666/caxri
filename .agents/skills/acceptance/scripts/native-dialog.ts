import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isOwnedRuntime, runtimeStateSchema } from './runtime-state';

interface ProcessRow {
    pid: number;
    ppid: number;
}

interface DialogOptions {
    button: string;
    command: 'click' | 'inspect';
    timeoutMs: number;
}

interface DialogMatch {
    count: number;
    pid: number | null;
}

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RUNTIME_PATH = join(PROJECT_ROOT, '.records', 'acceptance', 'runtime.json');
const MAX_DIALOG_TIMEOUT_MS = 120_000;
const HELP = `Inspect or click one native macOS dialog owned by the isolated Acceptance app.

Usage:
  native-dialog.ts inspect --button "Move to Trash" [--timeout-ms 10000]
  native-dialog.ts click --button "Move to Trash" [--timeout-ms 10000]
`;

function commandFailureDetail(error: unknown, timeoutMs: number): string {
    if (typeof error === 'object' && error !== null) {
        if ('stderr' in error && typeof error.stderr === 'string' && error.stderr.trim()) {
            return error.stderr.trim().split('\n').slice(-3).join(' ');
        }
        if ('killed' in error && error.killed === true) {
            return `osascript exceeded the ${timeoutMs}ms query timeout`;
        }
        if ('code' in error && (typeof error.code === 'number' || typeof error.code === 'string')) {
            return `osascript exited with code ${error.code}`;
        }
    }
    return 'osascript exited unsuccessfully';
}

export function parseDialogOptions(arguments_: string[]): DialogOptions | 'help' {
    if (arguments_.length === 0 || arguments_.includes('--help') || arguments_.includes('-h'))
        return 'help';
    const command = arguments_[0];
    if (command !== 'click' && command !== 'inspect') {
        throw new Error(`Unknown command: ${command}`);
    }

    let button: string | undefined;
    let timeoutMs = 10_000;
    for (let index = 1; index < arguments_.length; index += 2) {
        // `index < arguments_.length` (loop condition) guarantees `option` is in bounds.
        const option = arguments_[index];
        const value = arguments_[index + 1];
        if (!value || !option.startsWith('--') || value.startsWith('--')) {
            throw new Error(`Invalid option: ${option}`);
        }
        if (option === '--button') button = value;
        else if (option === '--timeout-ms') timeoutMs = Number(value);
        else throw new Error(`Unknown option: ${option}`);
    }
    if (!button) throw new Error('--button is required');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_DIALOG_TIMEOUT_MS) {
        throw new Error(`--timeout-ms must be an integer between 1 and ${MAX_DIALOG_TIMEOUT_MS}`);
    }
    return { button, command, timeoutMs };
}

export function collectProcessTree(rootPid: number, rows: ProcessRow[]): number[] {
    const children = new Map<number, number[]>();
    for (const row of rows) {
        const siblings = children.get(row.ppid) ?? [];
        siblings.push(row.pid);
        children.set(row.ppid, siblings);
    }

    const tree: number[] = [];
    const queue = [rootPid];
    const seen = new Set<number>();
    while (queue.length > 0) {
        const pid = queue.shift();
        if (!pid || seen.has(pid)) continue;
        seen.add(pid);
        tree.push(pid);
        queue.push(...(children.get(pid) ?? []));
    }
    return tree;
}

async function processTree(rootPid: number): Promise<number[]> {
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=', '-o', 'ppid=']);
    const rows = stdout
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([pid, ppid]) => Number.isSafeInteger(pid) && Number.isSafeInteger(ppid))
        .map(([pid, ppid]) => ({ pid, ppid }));
    return collectProcessTree(rootPid, rows);
}

const NATIVE_DIALOG_SCRIPT = [
    'on collectButtons(theContainer, targetButton)',
    'set matches to {}',
    'tell application "System Events"',
    'try',
    'set allElements to entire contents of (contents of theContainer)',
    'on error',
    'set allElements to {}',
    'end try',
    'repeat with candidate in allElements',
    'try',
    'if role of candidate is "AXButton" and name of candidate is targetButton then set end of matches to contents of candidate',
    'end try',
    'end repeat',
    'end tell',
    'return matches',
    'end collectButtons',
    'on run argv',
    'set actionName to item 1 of argv',
    'set targetButton to item 2 of argv',
    'set allowedPids to items 3 thru -1 of argv',
    'set matchedButtons to {}',
    'set matchedProcesses to {}',
    'set matchedPids to {}',
    'tell application "System Events"',
    'repeat with pidText in allowedPids',
    'try',
    'set targetPid to (contents of pidText) as integer',
    'set appProcess to first application process whose unix id is targetPid',
    'set frontmost of appProcess to true',
    'repeat with appWindow in windows of appProcess',
    'repeat with appSheet in sheets of appWindow',
    'set foundButtons to my collectButtons(appSheet, targetButton)',
    'repeat with foundButton in foundButtons',
    'set end of matchedButtons to contents of foundButton',
    'set end of matchedProcesses to appProcess',
    'set end of matchedPids to pidText',
    'end repeat',
    'end repeat',
    'try',
    'if subrole of appWindow is "AXDialog" and (count of sheets of appWindow) is 0 then',
    'set foundButtons to my collectButtons(appWindow, targetButton)',
    'repeat with foundButton in foundButtons',
    'set end of matchedButtons to contents of foundButton',
    'set end of matchedProcesses to appProcess',
    'set end of matchedPids to pidText',
    'end repeat',
    'end if',
    'end try',
    'end repeat',
    'end try',
    'end repeat',
    'set matchCount to count of matchedButtons',
    'if matchCount is 1 and actionName is "click" then',
    'set frontmost of item 1 of matchedProcesses to true',
    'click item 1 of matchedButtons',
    'end if',
    'end tell',
    'if matchCount is 0 then return "0" & tab',
    'return (matchCount as text) & tab & item 1 of matchedPids',
    'end run',
];

async function queryNativeDialog(
    pids: number[],
    options: Pick<DialogOptions, 'button' | 'command'>,
    timeoutMs: number,
): Promise<DialogMatch> {
    const commandArguments = NATIVE_DIALOG_SCRIPT.flatMap((line) => ['-e', line]);
    try {
        const { stdout } = await execFileAsync(
            'osascript',
            [...commandArguments, options.command, options.button, ...pids.map(String)],
            { timeout: timeoutMs },
        );
        const [rawCount, rawPid] = stdout.trimEnd().split('\t', 2);
        const count = Number(rawCount);
        const pid = rawPid ? Number(rawPid) : null;
        if (
            !Number.isSafeInteger(count) ||
            count < 0 ||
            (pid !== null && !Number.isSafeInteger(pid))
        ) {
            throw new Error(`Unexpected Accessibility response: ${stdout.trim()}`);
        }
        return { count, pid };
    } catch (error: unknown) {
        const detail = commandFailureDetail(error, timeoutMs);
        throw new Error(
            `Native dialog Accessibility query failed or timed out. Grant Accessibility access to the terminal running Caxri Acceptance. ${detail}`,
            { cause: error },
        );
    }
}

async function waitForSingleDialog(pids: number[], options: DialogOptions): Promise<number> {
    const deadline = Date.now() + options.timeoutMs;
    // This is a poll loop: each iteration must await the previous query and retry delay before
    // deciding whether to poll again, so the awaits below are intentionally sequential.
    do {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        // eslint-disable-next-line no-await-in-loop
        const match = await queryNativeDialog(pids, options, remainingMs);
        if (match.count > 1) {
            throw new Error(
                `Multiple native dialogs expose button "${options.button}" in the owned app`,
            );
        }
        if (match.count === 1 && match.pid) return match.pid;
        const pollDelayMs = Math.min(200, Math.max(0, deadline - Date.now()));
        // eslint-disable-next-line no-await-in-loop
        await new Promise<void>((resolve) => setTimeout(resolve, pollDelayMs));
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for one native dialog with button "${options.button}"`);
}

async function main(): Promise<void> {
    const options = parseDialogOptions(process.argv.slice(2));
    if (options === 'help') {
        console.log(HELP);
        return;
    }

    const runtime = runtimeStateSchema.parse(JSON.parse(await readFile(RUNTIME_PATH, 'utf8')));
    if (!(await isOwnedRuntime(runtime))) {
        throw new Error('Acceptance runtime state does not belong to a live owned process');
    }
    if (!runtime.electronPid) throw new Error('Owned Acceptance runtime has no Electron PID');

    const pids = await processTree(runtime.electronPid);
    const pid = await waitForSingleDialog(pids, options);
    const action = options.command === 'click' ? 'Clicked' : 'Found exactly one';
    console.log(`${action} native dialog button "${options.button}" in PID ${pid}`);
}

if (import.meta.main) {
    try {
        await main();
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

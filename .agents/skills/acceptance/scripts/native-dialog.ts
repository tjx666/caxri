import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runNativeAx } from './native-ax';
import { assertNativeDialogAuthorization } from './native-dialog-authorization';
import { isOwnedRuntime, runtimeStateSchema } from './runtime-state';

interface DialogOptions {
    button?: string;
    command: 'click' | 'inspect' | 'preflight';
    timeoutMs: number;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RUNTIME_PATH = join(PROJECT_ROOT, '.records', 'acceptance', 'runtime.json');
const MAX_DIALOG_TIMEOUT_MS = 120_000;
const HELP = `Inspect or click one native macOS dialog owned by the isolated Acceptance app.
Requires CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION=explicit-user-request from the current request.

Usage:
  native-dialog.ts preflight [--timeout-ms 3000]
  native-dialog.ts inspect --button "Move to Trash" [--timeout-ms 10000]
  native-dialog.ts click --button "Move to Trash" [--timeout-ms 10000]
`;

export function parseDialogOptions(arguments_: string[]): DialogOptions | 'help' {
    if (arguments_.length === 0 || arguments_.includes('--help') || arguments_.includes('-h')) {
        return 'help';
    }
    const command = arguments_[0];
    if (command !== 'click' && command !== 'inspect' && command !== 'preflight') {
        throw new Error(`Unknown command: ${command}`);
    }

    const values = new Map<string, string>();
    for (let index = 1; index < arguments_.length; index += 2) {
        const option = arguments_[index];
        const value = arguments_[index + 1];
        if (!value || !option.startsWith('--') || value.startsWith('--')) {
            throw new Error(`Invalid option: ${option}`);
        }
        if (option !== '--button' && option !== '--timeout-ms') {
            throw new Error(`Unknown option: ${option}`);
        }
        if (values.has(option)) throw new Error(`Duplicate option: ${option}`);
        values.set(option, value);
    }
    const button = values.get('--button');
    if (command !== 'preflight' && !button) throw new Error('--button is required');
    if (command === 'preflight' && button) throw new Error('--button is not valid for preflight');
    const rawTimeoutMs = values.get('--timeout-ms');
    const timeoutMs = rawTimeoutMs === undefined ? 10_000 : Number(rawTimeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_DIALOG_TIMEOUT_MS) {
        throw new Error(`--timeout-ms must be an integer between 1 and ${MAX_DIALOG_TIMEOUT_MS}`);
    }
    return { button, command, timeoutMs };
}

/**
 * The re-identified Acceptance app is the only valid owner of Caxri native windows. Renderer, GPU, Host, Runtime, and
 * AppKit service PIDs must never become alternative owners merely because a native query is difficult.
 */
export function ownedDialogProcessIds(runtime: { electronPid?: number | null }): number[] {
    if (!runtime.electronPid) throw new Error('Owned Acceptance runtime has no Electron PID');
    return [runtime.electronPid];
}

async function main(): Promise<void> {
    const options = parseDialogOptions(process.argv.slice(2));
    if (options === 'help') {
        console.log(HELP);
        return;
    }
    assertNativeDialogAuthorization();

    const runtime = runtimeStateSchema.parse(JSON.parse(await readFile(RUNTIME_PATH, 'utf8')));
    if (!(await isOwnedRuntime(runtime))) {
        throw new Error('Acceptance runtime state does not belong to a live owned process');
    }
    const [pid] = ownedDialogProcessIds(runtime);
    const nativeCommand =
        options.command === 'preflight'
            ? 'preflight'
            : options.command === 'click'
              ? 'dialog-press'
              : 'dialog-inspect';
    const result = await runNativeAx(nativeCommand, {
        button: options.button ?? 'preflight',
        pid,
        timeoutMs: options.timeoutMs,
    });
    if (options.command === 'preflight') {
        console.log(`Native dialog preflight passed for PID ${pid} (${result.elapsedMs}ms)`);
        return;
    }
    const action = options.command === 'click' ? 'Clicked' : 'Found exactly one';
    console.log(
        `${action} native dialog button "${options.button}" in PID ${pid} (${result.elapsedMs}ms)`,
    );
}

if (import.meta.main) {
    try {
        await main();
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}

import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runNativeAx } from './native-ax';
import { assertNativeDialogAuthorization } from './native-dialog-authorization';
import { isOwnedRuntime, runtimeStateSchema } from './runtime-state';

type OpenPanelCommand = 'choose-path' | 'click' | 'inspect';

interface OpenPanelOptions {
    button: string;
    command: OpenPanelCommand;
    path?: string;
    timeoutMs: number;
    title: string;
}

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
const RUNTIME_PATH = join(PROJECT_ROOT, '.records', 'acceptance', 'runtime.json');
const MAX_DIALOG_TIMEOUT_MS = 120_000;
const HELP = `Inspect or operate one macOS open panel owned by the isolated Acceptance app.
Requires CAXRI_ACCEPTANCE_NATIVE_DIALOG_AUTHORIZATION=explicit-user-request from the current request.

Usage:
  open-panel.ts inspect --title "Import Theme" --button "Open" [--timeout-ms 10000]
  open-panel.ts choose-path --title "Import Theme" --button "Open" --path fixture.json [--timeout-ms 10000]
  open-panel.ts click --title "Import Theme" --button "Open" [--timeout-ms 10000]
`;

export function parseOpenPanelOptions(arguments_: string[]): OpenPanelOptions | 'help' {
    if (arguments_.length === 0 || arguments_.includes('--help') || arguments_.includes('-h')) {
        return 'help';
    }
    const command = arguments_[0];
    if (command !== 'choose-path' && command !== 'click' && command !== 'inspect') {
        throw new Error(`Unknown command: ${command}`);
    }

    const allowedOptions = new Set(['--button', '--path', '--timeout-ms', '--title']);
    const values = new Map<string, string>();
    for (let index = 1; index < arguments_.length; index += 2) {
        const option = arguments_[index];
        const value = arguments_[index + 1];
        if (!value || !option.startsWith('--') || value.startsWith('--')) {
            throw new Error(`Invalid option: ${option}`);
        }
        if (!allowedOptions.has(option)) throw new Error(`Unknown option: ${option}`);
        if (values.has(option)) throw new Error(`Duplicate option: ${option}`);
        values.set(option, value);
    }
    const button = values.get('--button');
    if (!button) throw new Error('--button is required');
    if (button !== 'Open') throw new Error('--button must be the semantic Open action');
    const title = values.get('--title');
    if (!title) throw new Error('--title is required');
    const path = values.get('--path');
    if (command === 'choose-path' && !path) throw new Error('--path is required for choose-path');
    if (command !== 'choose-path' && path) throw new Error('--path is valid only for choose-path');
    const rawTimeoutMs = values.get('--timeout-ms');
    const timeoutMs = rawTimeoutMs === undefined ? 10_000 : Number(rawTimeoutMs);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_DIALOG_TIMEOUT_MS) {
        throw new Error(`--timeout-ms must be an integer between 1 and ${MAX_DIALOG_TIMEOUT_MS}`);
    }
    return { button, command, path, timeoutMs, title };
}

export async function resolveFixturePath(path: string): Promise<string> {
    const canonicalProjectRoot = await realpath(PROJECT_ROOT);
    const candidate = await realpath(resolve(PROJECT_ROOT, path));
    const relativePath = relative(canonicalProjectRoot, candidate);
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
        throw new Error('Open-panel fixture must remain inside the current Acceptance worktree');
    }
    if (relativePath.split(sep).some((component) => component.startsWith('.'))) {
        throw new Error(
            'Open-panel fixture path contains a hidden component; stage chooser fixtures under test-results/acceptance-native',
        );
    }
    const metadata = await stat(candidate);
    if (!metadata.isFile()) throw new Error('Open-panel fixture must be a regular file');
    return candidate;
}

async function main(): Promise<void> {
    const options = parseOpenPanelOptions(process.argv.slice(2));
    if (options === 'help') {
        console.log(HELP);
        return;
    }
    assertNativeDialogAuthorization();
    const runtime = runtimeStateSchema.parse(JSON.parse(await readFile(RUNTIME_PATH, 'utf8')));
    if (!(await isOwnedRuntime(runtime))) {
        throw new Error('Acceptance runtime state does not belong to a live owned process');
    }
    if (!runtime.electronPid) throw new Error('Owned Acceptance runtime has no Electron PID');

    const path = options.path ? await resolveFixturePath(options.path) : undefined;
    const command =
        options.command === 'choose-path'
            ? 'open-panel-select'
            : options.command === 'click'
              ? 'open-panel-press'
              : 'open-panel-inspect';
    const result = await runNativeAx(command, {
        button: options.button,
        path,
        pid: runtime.electronPid,
        timeoutMs: options.timeoutMs,
        title: options.title,
    });
    const action =
        options.command === 'choose-path'
            ? `Selected ${result.selectedPath}`
            : options.command === 'click'
              ? 'Clicked'
              : 'Found exactly one';
    console.log(
        `${action} native open-panel button "${options.button}" in PID ${runtime.electronPid} (${result.elapsedMs}ms; native title "${result.title ?? ''}")`,
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

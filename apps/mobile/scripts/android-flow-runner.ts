import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CAXRI_ANDROID_PACKAGE, runAndroidAdb } from './android-device-bridge';
import { isDebuggablePackageDump } from './android-flow-receipts';

const mobileRoot = join(import.meta.dirname, '..');
const ANDROID_FLOWS_DIRECTORY = join(mobileRoot, 'flows');
const AGENT_DEVICE_BIN = join(mobileRoot, 'node_modules', '.bin', 'agent-device');
const FLOW_TIMEOUT_MS = 120_000;
const ANDROID_FLOW_ARTIFACTS_DIRECTORY = join(
    mobileRoot,
    '..',
    '..',
    'test-results',
    'mobile-flows',
);

/**
 * Stops Caxri and clears its data, the same reset a flow's `launchApp.clearState` performs.
 */
export const clearCaxriData = (serial: string): void => {
    runAndroidAdb(serial, ['shell', 'pm', 'clear', CAXRI_ANDROID_PACKAGE]);
};

/**
 * Fails before any device mutation when the build under test is missing, so a stale run never reads as a pass. `pm
 * path` exits 1 for an unknown package, which `runAndroidAdb` raises as a bare status error.
 */
export const requireInstalledCaxri = (serial: string): void => {
    let installedPath = '';
    try {
        installedPath = runAndroidAdb(serial, ['shell', 'pm', 'path', CAXRI_ANDROID_PACKAGE]);
    } catch {
        // Reported below with the actionable message.
    }
    if (!installedPath) throw new Error('Caxri is not installed on the selected emulator');
};

/**
 * Reads the installed package's DEBUGGABLE flag so a receipt never labels a debug or development-client install as a
 * release build.
 */
export const isInstalledCaxriDebuggable = (serial: string): boolean =>
    isDebuggablePackageDump(
        runAndroidAdb(serial, ['shell', 'dumpsys', 'package', CAXRI_ANDROID_PACKAGE]),
    );

export const listAndroidFlows = async (): Promise<string[]> =>
    (await readdir(ANDROID_FLOWS_DIRECTORY))
        .filter((name) => name.endsWith('.yaml'))
        .map((name) => name.slice(0, -'.yaml'.length))
        .toSorted((left, right) => left.localeCompare(right));

/**
 * Closes system dialogs such as "System UI isn't responding", which a loaded emulator raises over the app and which
 * would otherwise fail the first wait of a flow.
 */
const closeAndroidSystemDialogs = (serial: string): void => {
    runAndroidAdb(serial, [
        'shell',
        'am',
        'broadcast',
        '-a',
        'android.intent.action.CLOSE_SYSTEM_DIALOGS',
    ]);
};

/**
 * Runs Maestro YAML flows as one agent-device suite and returns its exit status. `test` opens and closes a session per
 * flow, so no flow leaves the emulator claimed for the next one, unlike `replay`.
 */
export const runAndroidFlows = async (
    serial: string,
    flows: string[],
    output: 'inherit' | 'errors-only',
): Promise<number> => {
    closeAndroidSystemDialogs(serial);
    // Asynchronous on purpose: the benchmark's profiler polls the device on this event loop while the flow runs.
    const child = spawn(
        AGENT_DEVICE_BIN,
        [
            'test',
            ...flows.map((flow) => join(ANDROID_FLOWS_DIRECTORY, `${flow}.yaml`)),
            '--maestro',
            '--platform',
            'android',
            '--serial',
            serial,
            '--timeout',
            String(FLOW_TIMEOUT_MS),
            '--artifacts-dir',
            ANDROID_FLOW_ARTIFACTS_DIRECTORY,
        ],
        // The benchmark keeps agent-device's failure report on stderr so a failed iteration stays diagnosable.
        { shell: false, stdio: output === 'inherit' ? 'inherit' : ['ignore', 'ignore', 'inherit'] },
    );
    return new Promise((resolve, reject) => {
        child.once('error', () => reject(new Error('agent-device failed to start')));
        child.once('close', (code) => resolve(code ?? 1));
    });
};

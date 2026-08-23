import type { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { execFileAsync } from '../../../../src/shared/node/exec';

const APP_BUNDLE_SUFFIXES = [
    { bundleSuffix: '', helperApp: null },
    { bundleSuffix: '.helper', helperApp: 'Electron Helper.app' },
    { bundleSuffix: '.helper.gpu', helperApp: 'Electron Helper (GPU).app' },
    { bundleSuffix: '.helper.plugin', helperApp: 'Electron Helper (Plugin).app' },
    { bundleSuffix: '.helper.renderer', helperApp: 'Electron Helper (Renderer).app' },
] as const;

interface AcceptanceAppIdentityInput {
    caseId: string;
    nonce: string;
    sourceAppPath: string;
    userDataDir: string;
}

interface PrepareAcceptanceAppInput {
    caseId: string;
    sourceAppPath: string;
    userDataDir: string;
}

type ExecuteFile = (
    command: string,
    arguments_: string[],
) => Promise<{ stderr: Buffer | string; stdout: Buffer | string }>;

interface PrepareAcceptanceAppDependencies {
    execute: ExecuteFile;
    makeDirectory: (path: string) => Promise<void>;
    nonce: () => string;
}

interface WaitForMacosAcceptanceProcessDependencies {
    listProcesses: () => Promise<string>;
    now: () => number;
    sleep: (milliseconds: number) => Promise<void>;
}

export interface MacosAcceptanceAppPlan {
    appName: string;
    appPath: string;
    bundleId: string;
    executablePath: string;
    plists: Array<{
        bundleId: string;
        displayNameOperation: '-insert' | '-replace';
        name: string;
        path: string;
    }>;
    sourceAppPath: string;
}

const defaultDependencies: PrepareAcceptanceAppDependencies = {
    execute: (command, arguments_) => execFileAsync(command, arguments_),
    makeDirectory: async (path) => {
        await mkdir(path, { recursive: true });
    },
    nonce: randomUUID,
};

const defaultWaitDependencies: WaitForMacosAcceptanceProcessDependencies = {
    listProcesses: async () => {
        const { stdout } = await execFileAsync('/bin/ps', ['-ww', '-axo', 'pid=,command=']);
        return String(stdout);
    },
    now: Date.now,
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function identitySegment(value: string, label: string): string {
    const normalized = value
        .toLowerCase()
        .replaceAll(/[^a-z0-9-]+/g, '-')
        .replaceAll(/^-+|-+$/g, '');
    if (!normalized) throw new Error(`${label} cannot form a macOS bundle identity`);
    return normalized.slice(0, 63);
}

function nonceSegment(value: string): string {
    const normalized = value.toLowerCase().replaceAll(/[^a-z0-9]+/g, '');
    if (normalized.length < 8) throw new Error('Acceptance app identity nonce is too short');
    return normalized.slice(0, 32);
}

/**
 * A stock development Electron bundle always identifies as `com.github.Electron`. macOS uses the bundle identifier as
 * the system application identity, so Accessibility can otherwise route a semantic action to an unrelated Caxri dev
 * window. A per-launch identity keeps the owned Acceptance app distinguishable without stopping or mutating any sibling
 * process.
 *
 * @see https://developer.apple.com/documentation/bundleresources/information-property-list/cfbundleidentifier
 * @see https://www.electronjs.org/docs/latest/tutorial/application-distribution#rebranding-with-downloaded-binaries
 */
export function createMacosAcceptanceAppPlan({
    caseId,
    nonce,
    sourceAppPath,
    userDataDir,
}: AcceptanceAppIdentityInput): MacosAcceptanceAppPlan {
    const launchIdentity = nonceSegment(nonce);
    const bundleId = `dev.caxri.acceptance.${identitySegment(caseId, 'Case id')}.${launchIdentity}`;
    const appName = `Caxri Acceptance ${launchIdentity.slice(0, 8)}`;
    const appPath = join(userDataDir, 'apps.noindex', `${appName}.app`);
    const executableDirectory = join(appPath, 'Contents', 'MacOS');
    const frameworksPath = join(appPath, 'Contents', 'Frameworks');
    const plists = APP_BUNDLE_SUFFIXES.map(({ bundleSuffix, helperApp }) => ({
        bundleId: `${bundleId}${bundleSuffix}`,
        displayNameOperation: helperApp ? ('-insert' as const) : ('-replace' as const),
        name: helperApp ? `${appName} Helper` : appName,
        path: helperApp
            ? join(frameworksPath, helperApp, 'Contents', 'Info.plist')
            : join(appPath, 'Contents', 'Info.plist'),
    }));

    return {
        appName,
        appPath,
        bundleId,
        executablePath: join(executableDirectory, 'Electron'),
        plists,
        sourceAppPath,
    };
}

/**
 * The LaunchServices-owned app keeps Electron's stock executable name so `app.isPackaged` remains false. The absolute
 * temporary bundle path is unique per Acceptance launch, and the first app argument is always the absolute project
 * root, which distinguishes the main process from every helper command.
 */
export function findMacosAcceptanceProcessIds(
    processTable: string,
    executablePath: string,
): number[] {
    const commandPrefix = `${executablePath} /`;
    return processTable.split(/\r?\n/u).flatMap((line) => {
        const trimmed = line.trimStart();
        const separatorIndex = trimmed.search(/\s/u);
        if (separatorIndex < 1) return [];
        const pid = Number(trimmed.slice(0, separatorIndex));
        const command = trimmed.slice(separatorIndex).trimStart();
        if (!Number.isSafeInteger(pid) || !command.startsWith(commandPrefix)) return [];
        return [pid];
    });
}

export async function waitForMacosAcceptanceProcess(
    executablePath: string,
    dependencies: WaitForMacosAcceptanceProcessDependencies = defaultWaitDependencies,
): Promise<number> {
    const deadline = dependencies.now() + 10_000;
    while (dependencies.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop -- launch discovery is a bounded sequential poll
        const processTable = await dependencies.listProcesses();
        const processIds = findMacosAcceptanceProcessIds(processTable, executablePath);
        if (processIds.length > 1) {
            throw new Error('Multiple processes launched from the unique Acceptance app path');
        }
        if (processIds[0]) return processIds[0];
        // eslint-disable-next-line no-await-in-loop -- launch discovery is a bounded sequential poll
        await dependencies.sleep(100);
    }
    throw new Error('Timed out waiting for the unique Acceptance Electron process');
}

export async function prepareMacosAcceptanceApp(
    input: PrepareAcceptanceAppInput,
    dependencies: PrepareAcceptanceAppDependencies = defaultDependencies,
): Promise<MacosAcceptanceAppPlan> {
    const plan = createMacosAcceptanceAppPlan({ ...input, nonce: dependencies.nonce() });
    await dependencies.makeDirectory(join(input.userDataDir, 'apps.noindex'));
    await dependencies.execute('/bin/cp', ['-cR', plan.sourceAppPath, plan.appPath]);
    for (const plist of plan.plists) {
        // These edits target distinct plist files but remain ordered to make a partial failure
        // deterministic and leave the entire owned profile available for normal cleanup.
        // eslint-disable-next-line no-await-in-loop
        await dependencies.execute('/usr/bin/plutil', [
            '-replace',
            'CFBundleIdentifier',
            '-string',
            plist.bundleId,
            plist.path,
        ]);
        // eslint-disable-next-line no-await-in-loop
        await dependencies.execute('/usr/bin/plutil', [
            '-replace',
            'CFBundleName',
            '-string',
            plist.name,
            plist.path,
        ]);
        // eslint-disable-next-line no-await-in-loop
        await dependencies.execute('/usr/bin/plutil', [
            plist.displayNameOperation,
            'CFBundleDisplayName',
            '-string',
            plist.name,
            plist.path,
        ]);
    }
    const { stdout } = await dependencies.execute('/usr/bin/plutil', [
        '-extract',
        'CFBundleIdentifier',
        'raw',
        plan.plists[0].path,
    ]);
    if (String(stdout).trim() !== plan.bundleId) {
        throw new Error('Acceptance app bundle identity verification failed');
    }
    /**
     * AppKit hosts modern open/save panels through ViewBridge. Re-sign the cloned bundle after changing its identity so
     * LaunchServices and remote AppKit services observe one coherent bundle instead of the source Electron signature.
     * Ad-hoc signing remains local, deterministic, and does not grant distribution authority.
     */
    await dependencies.execute('/usr/bin/codesign', [
        '--force',
        '--deep',
        '--sign',
        '-',
        plan.appPath,
    ]);
    return plan;
}

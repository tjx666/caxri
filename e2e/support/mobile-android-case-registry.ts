import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';

/**
 * The report-bound identity the guarded Android runner hands every case. `remoteVideoPath` is set only for a case whose
 * scenario owns its recording; `launchId` and `sourceCommit` bind the cases that write their own lifecycle receipts.
 */
export interface MobileAndroidCaseEnvironment extends MobileAgentScenarioEnvironment {
    launchId?: string;
    remoteVideoPath?: string;
    sourceCommit?: string;
}

export type MobileAndroidCaseHandler = (
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
) => Promise<void>;

export function requireRemoteVideoPath({ remoteVideoPath }: MobileAndroidCaseEnvironment): string {
    if (!remoteVideoPath) throw new Error('Scenario-owned Android recording path is unavailable');
    return remoteVideoPath;
}

/**
 * Narrows the environment for a case that writes its own lifecycle receipts, which need the launch and source commit.
 */
export function requireLaunchIdentity(
    environment: MobileAndroidCaseEnvironment,
    label: string,
): MobileAndroidCaseEnvironment & { launchId: string; sourceCommit: string } {
    const { launchId, sourceCommit } = environment;
    if (!sourceCommit || !launchId) throw new Error(`${label} Acceptance identity is incomplete`);
    return { ...environment, launchId, sourceCommit };
}

const CASES_DIRECTORY = join(
    dirname(fileURLToPath(import.meta.url)),
    'mobile-android-case-handlers',
);

/**
 * Lists the handler modules a self-registered case may live in: every `mobile-android-case-handlers/<group>.ts` except
 * tests.
 */
export function mobileAndroidCaseGroups(directory = CASES_DIRECTORY): string[] {
    return readdirSync(directory)
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
        .map((file) => file.slice(0, -'.ts'.length))
        .toSorted((a, b) => a.localeCompare(b));
}

/**
 * Collects the handlers every `mobile-android-case-handlers/<group>.ts` module exports as `handlers`, keyed by case id.
 * A duplicate id fails loudly, so two parallel sessions cannot silently shadow each other's case.
 */
export async function collectMobileAndroidCaseHandlers(
    directory = CASES_DIRECTORY,
): Promise<Map<string, MobileAndroidCaseHandler>> {
    const collected = new Map<string, MobileAndroidCaseHandler>();
    const groups = mobileAndroidCaseGroups(directory);
    const modules = await Promise.all(
        groups.map(
            (group) =>
                import(pathToFileURL(join(directory, `${group}.ts`)).href) as Promise<{
                    handlers?: Record<string, MobileAndroidCaseHandler>;
                }>,
        ),
    );
    for (const [index, module] of modules.entries()) {
        if (!module.handlers) {
            throw new Error(
                `mobile-android-case-handlers/${groups[index]}.ts must export handlers`,
            );
        }
        for (const [caseId, handler] of Object.entries(module.handlers)) {
            if (collected.has(caseId)) throw new Error(`Duplicate Android case handler: ${caseId}`);
            collected.set(caseId, handler);
        }
    }
    return collected;
}

/**
 * Runs the self-registered Android Acceptance case `environment.caseId` through the handler its own group module
 * registered.
 */
export async function executeMobileAndroidCase(
    environment: MobileAndroidCaseEnvironment,
    artifacts: string[],
): Promise<void> {
    const handler = (await collectMobileAndroidCaseHandlers()).get(environment.caseId);
    if (!handler) {
        throw new Error(`Unsupported Playwright mobile Acceptance case: ${environment.caseId}`);
    }
    return handler(environment, artifacts);
}

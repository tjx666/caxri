import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { MobileAndroidCaseDefinition } from './mobile-android-cases';

const CASES_DIRECTORY = join(
    dirname(fileURLToPath(import.meta.url)),
    'mobile-android-case-definitions',
);

/**
 * Collects the definitions every `mobile-android-case-definitions/<group>.ts` module exports as `cases`, keyed by case
 * id (`MOB-<FEATURE>-*`, such as `MOB-CHAT-RUNNING-OPEN-01` or `MOB-PAIR-02`). Every Android Acceptance case lives in
 * one of these dependency-free modules; this never imports the Playwright handlers in
 * `e2e/support/mobile-android-case-handlers/<group>.ts`. A duplicate id or a non-`MOB-` id fails loudly.
 */
export async function collectAndroidCases(
    directory = CASES_DIRECTORY,
): Promise<Record<string, MobileAndroidCaseDefinition>> {
    const collected: Record<string, MobileAndroidCaseDefinition> = {};
    const groups = (await readdir(directory))
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
        .toSorted((a, b) => a.localeCompare(b));
    const modules = await Promise.all(
        groups.map(
            (file) =>
                import(pathToFileURL(join(directory, file)).href) as Promise<{
                    cases?: Record<string, MobileAndroidCaseDefinition>;
                }>,
        ),
    );
    for (const [index, module] of modules.entries()) {
        const file = groups[index];
        if (!module.cases)
            throw new Error(`mobile-android-case-definitions/${file} must export cases`);
        for (const [caseId, definition] of Object.entries(module.cases)) {
            if (!caseId.startsWith('MOB-')) {
                throw new Error(`Android case ${caseId} in ${file} must start with MOB-`);
            }
            if (Object.hasOwn(collected, caseId)) {
                throw new Error(`Duplicate Android case definition: ${caseId}`);
            }
            collected[caseId] = definition;
        }
    }
    return collected;
}

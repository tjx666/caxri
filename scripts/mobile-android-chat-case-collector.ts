import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { MobileAndroidCaseDefinition } from './mobile-android-cases';

const CASES_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'mobile-android-chat-cases');

/**
 * Collects the definitions every `mobile-android-chat-cases/<group>.ts` module exports as `cases`, keyed by case id
 * (`MOB-CHAT-*`). It imports only these dependency-free modules, never the Playwright handlers in
 * `e2e/support/mobile-chat-cases/<group>.ts`. A duplicate id or a non-Chat id fails loudly.
 */
export async function collectAndroidChatCases(
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
        if (!module.cases) throw new Error(`mobile-android-chat-cases/${file} must export cases`);
        for (const [caseId, definition] of Object.entries(module.cases)) {
            if (!caseId.startsWith('MOB-CHAT-')) {
                throw new Error(`Agent Chat case ${caseId} in ${file} must start with MOB-CHAT-`);
            }
            if (Object.hasOwn(collected, caseId)) {
                throw new Error(`Duplicate Agent Chat case definition: ${caseId}`);
            }
            collected[caseId] = definition;
        }
    }
    return collected;
}

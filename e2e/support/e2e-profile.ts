import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stageDevelopmentTestExtension } from './test-extension.ts';

/**
 * Settings every E2E profile starts from when the spec has not written its own `settings.jsonc`.
 *
 * `files.autoSave` defaults to `onFocusChange` in the product, but most Editor specs type into a buffer and then click
 * elsewhere while asserting it is still unsaved (the close and quit confirmations, Workbench Root switches, Session
 * deletion). They opt out of auto save so that focus moves stay inert; `editor-auto-save.e2e.ts` covers the default.
 */
const E2E_DEFAULT_SETTINGS = { 'files.autoSave': 'off' } as const;

export function e2eSettingsPath(userDataDirectory: string): string {
    return join(userDataDirectory, 'config', 'settings.jsonc');
}

/**
 * Prepares a launch profile. Seeding uses the exclusive `wx` flag, so a spec that wrote its own settings first, or a
 * restart reusing the profile, keeps what is already there.
 */
export async function prepareE2EProfile(
    projectRoot: string,
    userDataDirectory: string,
    executablePath: string | undefined,
): Promise<void> {
    if (!executablePath) await stageDevelopmentTestExtension(projectRoot, userDataDirectory);
    await mkdir(join(userDataDirectory, 'config'), { recursive: true });
    try {
        await writeFile(
            e2eSettingsPath(userDataDirectory),
            `${JSON.stringify(E2E_DEFAULT_SETTINGS, null, 2)}\n`,
            { flag: 'wx' },
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
}

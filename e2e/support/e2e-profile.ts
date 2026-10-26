import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stageDevelopmentTestExtension } from './test-extension.ts';

/**
 * Settings every E2E profile starts from when the spec has not written its own `settings.jsonc`.
 *
 * `files.autoSave` defaults to `onFocusChange` in the product, but most Editor specs type into a buffer and then click
 * elsewhere while asserting it is still unsaved (the close and quit confirmations, Workbench Root switches, Session
 * deletion). They opt out of auto save so that focus moves stay inert; `editor-auto-save.e2e.ts` covers the default.
 *
 * `session.openAgentsInChat` defaults to true for users, but most specs drive the PTY Agent surface by its plain
 * create-menu name ("Claude", not "Claude Chat"), so the baseline keeps Terminal; Chat specs turn it on themselves.
 */
const E2E_DEFAULT_SETTINGS = {
    'files.autoSave': 'off',
    'session.openAgentsInChat': false,
} as const;

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

/**
 * `settings.update` replaces the whole settings file, so a spec that writes only the keys it cares about would also
 * drop the `session.openAgentsInChat` baseline above and silently turn its Agent Sessions into Chats. Keeps that one
 * key unless the spec sets it; other methods and any source that is not a plain JSON object pass through untouched.
 */
export function withE2EAgentSurfaceBaseline(method: string, parameters: unknown): unknown {
    if (method !== 'settings.update' || !isRecord(parameters)) return parameters;
    if (typeof parameters.source !== 'string') return parameters;
    let settings: unknown;
    try {
        settings = JSON.parse(parameters.source);
    } catch {
        return parameters;
    }
    if (!isRecord(settings)) return parameters;
    const baseline = {
        'session.openAgentsInChat': E2E_DEFAULT_SETTINGS['session.openAgentsInChat'],
    };
    return { ...parameters, source: JSON.stringify({ ...baseline, ...settings }, null, 2) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

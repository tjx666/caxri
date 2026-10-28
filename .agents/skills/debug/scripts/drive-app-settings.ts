import type { Page } from '@playwright/test';

import { CommandError } from '../../switch-worktree/scripts/process';

/**
 * Sends one typed request through the window's `caxri` bridge and throws its error, since the bridge resolves a failure
 * as `{ ok: false }` instead of rejecting.
 */
export async function request<T>(page: Page, method: string, parameters?: unknown): Promise<T> {
    const reply = (await page.evaluate(
        ([requestMethod, requestParameters]) =>
            (
                globalThis as unknown as {
                    caxri: { request(method: string, parameters_?: unknown): Promise<unknown> };
                }
            ).caxri.request(requestMethod, requestParameters),
        [method, parameters] as const,
    )) as { ok: true; result: T } | { ok: false; error: { code: string; message: string } };
    if (!reply.ok) throw new Error(`${method} failed: ${reply.error.code}: ${reply.error.message}`);
    return reply.result;
}

/**
 * Reads the current settings and writes back the whole source `edit` returns.
 */
export async function updateSettings(
    page: Page,
    edit: (settings: Record<string, unknown>) => string,
): Promise<void> {
    const settings = await request<{ value: Record<string, unknown> }>(page, 'settings.get');
    await request(page, 'settings.update', { source: edit(settings.value) });
}

/**
 * `settings.update` replaces the whole settings source rather than patching one key, so the language goes into the
 * current values. `system` clears the override, which follows the macOS language.
 */
export function settingsSourceWithLanguage(
    settings: Record<string, unknown>,
    language: string,
): string {
    if (!['en', 'zh-CN', 'system'].includes(language)) {
        throw new CommandError(`Language must be en, zh-CN, or system, not ${language}`, 2);
    }
    return JSON.stringify(
        { ...settings, 'workbench.language': language === 'system' ? null : language },
        null,
        4,
    );
}

/**
 * The whole settings source with `folders` appended to `security.trustedFolders`, skipping rules already present.
 */
export function settingsSourceWithTrustedFolders(
    settings: Record<string, unknown>,
    folders: readonly string[],
): string {
    const current = Array.isArray(settings['security.trustedFolders'])
        ? (settings['security.trustedFolders'] as string[])
        : [];
    return JSON.stringify(
        { ...settings, 'security.trustedFolders': [...new Set([...current, ...folders])] },
        null,
        4,
    );
}

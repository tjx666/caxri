import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { AppSettings, ThemeTokens } from '@caxri/protocol';
import {
    CaxriError,
    defaultThemeIdForScheme,
    IMPORTED_THEME_ID_PREFIX,
    MAX_IMPORTED_THEMES,
} from '@caxri/protocol';

import { atomicWrite } from '../atomic-file';
import { parseCaxriTheme, serializeTheme } from '../theme';
import { setJsoncValue } from './reconcile';
import { readBoundedConfigSource } from './source';

const THEME_FILE_SUFFIX = '.json';

/**
 * The id an imported theme is saved under: its name as a slug behind {@link IMPORTED_THEME_ID_PREFIX}, so importing a
 * file with the same name again replaces the earlier import instead of adding a near-duplicate.
 */
export function importedThemeId(name: string): string {
    const slug = name
        .normalize('NFKD')
        .toLowerCase()
        .replaceAll(/[^\da-z]+/gu, '-')
        .replaceAll(/^-+|-+$/gu, '')
        .slice(0, 64);
    return `${IMPORTED_THEME_ID_PREFIX}${slug || 'theme'}`;
}

/**
 * The themes Import Theme saved under `config/themes/`, one `<id>.json` each, which the "Follow system appearance"
 * slots can name. `theme.json` stays the editable current theme; this catalog only keeps every import so a later import
 * does not lose the earlier one. Files are read once at startup and changed only through Caxri, so the catalog is not
 * watched: a file edited by hand applies at the next launch.
 */
export class ImportedThemeCatalog {
    private themes: ThemeTokens[] = [];

    constructor(
        private readonly directory: string,
        private readonly write: (path: string, source: string) => Promise<void> = atomicWrite,
    ) {}

    private pathFor(id: string): string {
        return join(this.directory, `${id}${THEME_FILE_SUFFIX}`);
    }

    list(): readonly ThemeTokens[] {
        return this.themes;
    }

    /**
     * Reads every saved theme. A file that is missing, oversized, or no longer parses is skipped rather than failing
     * startup; a slot naming it falls back to its default preset.
     */
    async load(): Promise<void> {
        let names: string[];
        try {
            names = await readdir(this.directory);
        } catch {
            this.themes = [];
            return;
        }
        const files = names
            .filter((name) => name.startsWith(IMPORTED_THEME_ID_PREFIX))
            .filter((name) => name.endsWith(THEME_FILE_SUFFIX))
            .toSorted((left, right) => left.localeCompare(right))
            .slice(0, MAX_IMPORTED_THEMES);
        const loaded = await Promise.all(
            files.map(async (name) => {
                try {
                    const theme = parseCaxriTheme(
                        await readBoundedConfigSource(join(this.directory, name)),
                    );
                    return theme.id === name.slice(0, -THEME_FILE_SUFFIX.length)
                        ? theme
                        : undefined;
                } catch {
                    return;
                }
            }),
        );
        this.themes = sortByName(loaded.filter((theme) => theme !== undefined));
    }

    /**
     * Saves one import under its {@link importedThemeId}, replacing an earlier import of the same name, and returns the
     * theme as saved.
     */
    async save(theme: ThemeTokens): Promise<ThemeTokens> {
        const id = importedThemeId(theme.name);
        const isReplacement = this.themes.some((candidate) => candidate.id === id);
        if (!isReplacement && this.themes.length >= MAX_IMPORTED_THEMES)
            throw new CaxriError(
                'CAPACITY',
                `Caxri keeps at most ${MAX_IMPORTED_THEMES} imported themes; remove one in Settings > Theme first`,
            );
        const saved: ThemeTokens = { ...theme, id };
        await this.write(this.pathFor(id), serializeTheme(saved));
        this.themes = sortByName([
            ...this.themes.filter((candidate) => candidate.id !== id),
            saved,
        ]);
        return saved;
    }

    /**
     * Deletes one saved theme. Returns `false` when no import has that id.
     */
    async remove(id: string): Promise<boolean> {
        if (this.themes.every((theme) => theme.id !== id)) return false;
        await rm(this.pathFor(id), { force: true });
        this.themes = this.themes.filter((theme) => theme.id !== id);
        return true;
    }
}

function sortByName(themes: ThemeTokens[]): ThemeTokens[] {
    return themes.toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * The `settings.jsonc` source with every light or dark slot that named `id` set back to its appearance's default
 * preset, or `undefined` when no slot named it. Only those two leaves are edited, so comments and formatting survive.
 */
export function releaseThemeSlots(
    source: string,
    settings: Pick<AppSettings, 'workbench.theme.dark' | 'workbench.theme.light'>,
    id: string,
): string | undefined {
    let next = source;
    for (const scheme of ['light', 'dark'] as const) {
        const key = `workbench.theme.${scheme}` as const;
        if (settings[key] !== id) continue;
        next = setJsoncValue(next, [key], defaultThemeIdForScheme(scheme));
    }
    return next === source ? undefined : next;
}

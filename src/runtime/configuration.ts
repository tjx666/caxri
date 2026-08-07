import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import parcelWatcher from '@parcel/watcher';
import { z } from 'zod';

import { agentProviderIds } from '../shared/agents';
import { defaultKeybindings } from '../shared/commands';
import { errorMessage } from '../shared/ipc/errors';
import type { RuntimeEvent } from '../shared/ipc/events';
import { parseJsonc } from '../shared/node/jsonc';
import type { StructuredLogger } from '../shared/node/logger';
import {
    DEFAULT_FILES_EXCLUDE,
    keybindingSchema as sharedKeybindingSchema,
    SETTINGS_BOUNDS,
    type AppSettings,
    type Keybinding,
    type KeybindingConflict,
    type ThemeTokens,
} from '../shared/types';
import { NATIVE_WATCHER_BACKEND } from './native-watcher';
import { draculaTheme, importTheme, parseCaxriTheme, serializeTheme } from './theme';

type ConfigurationKind = 'settings' | 'keybindings' | 'theme';

interface WatcherSubscription {
    unsubscribe(): Promise<void>;
}

const WATCH_SETTLE_DELAY_MS = 100;
const FALLBACK_POLL_INTERVAL_MS = 250;
const MAX_FILES_EXCLUDE_PATTERNS = 100;

const filesExcludeSchema = z
    .record(z.string().min(1).max(256), z.boolean())
    .refine((value) => Object.keys(value).length <= MAX_FILES_EXCLUDE_PATTERNS, {
        message: `files.exclude supports at most ${MAX_FILES_EXCLUDE_PATTERNS} patterns`,
    })
    .default({})
    .transform((value) => ({ ...DEFAULT_FILES_EXCLUDE, ...value }));

/**
 * Bounds and defaults come from `SETTINGS_BOUNDS` in `src/shared/ipc/domain.ts`, keeping the strict
 * Runtime validation here linked to the wire-shape `appSettingsSchema` it validates against.
 */
const settingsSchema = z.object({
    'session.defaultAgent': z
        .enum([...agentProviderIds, 'shell'])
        .nullable()
        .default(null),
    'terminal.fontSize': z
        .number()
        .int()
        .min(SETTINGS_BOUNDS['terminal.fontSize'].min)
        .max(SETTINGS_BOUNDS['terminal.fontSize'].max)
        .default(SETTINGS_BOUNDS['terminal.fontSize'].default),
    'terminal.scrollback': z
        .number()
        .int()
        .min(SETTINGS_BOUNDS['terminal.scrollback'].min)
        .max(SETTINGS_BOUNDS['terminal.scrollback'].max)
        .default(SETTINGS_BOUNDS['terminal.scrollback'].default),
    'files.exclude': filesExcludeSchema,
    'files.maxFileBytes': z
        .number()
        .int()
        .min(SETTINGS_BOUNDS['files.maxFileBytes'].min)
        .max(SETTINGS_BOUNDS['files.maxFileBytes'].max)
        .default(SETTINGS_BOUNDS['files.maxFileBytes'].default),
});

const keybindingSchema = z.array(sharedKeybindingSchema);

const defaultSettings: AppSettings = {
    'session.defaultAgent': null,
    'terminal.fontSize': SETTINGS_BOUNDS['terminal.fontSize'].default,
    'terminal.scrollback': SETTINGS_BOUNDS['terminal.scrollback'].default,
    'files.exclude': { ...DEFAULT_FILES_EXCLUDE },
    'files.maxFileBytes': SETTINGS_BOUNDS['files.maxFileBytes'].default,
};

async function atomicWrite(path: string, source: string): Promise<void> {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
        const file = await open(temporary, 'wx', 0o600);
        try {
            await file.writeFile(source, 'utf8');
            await file.sync();
        } finally {
            await file.close();
        }
        await rename(temporary, path);
        const directoryHandle = await open(directory, 'r');
        try {
            await directoryHandle.sync();
        } finally {
            await directoryHandle.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

export function findKeybindingConflicts(keybindings: Keybinding[]): KeybindingConflict[] {
    const byKey = new Map<string, Set<string>>();
    for (const binding of keybindings) {
        const key = binding.key.trim().toLowerCase();
        const commands = byKey.get(key) ?? new Set<string>();
        commands.add(binding.command);
        byKey.set(key, commands);
    }
    const conflicts: KeybindingConflict[] = [];
    for (const [key, commands] of byKey)
        if (commands.size > 1) conflicts.push({ key, commands: [...commands] });
    return conflicts;
}

export class ConfigurationService {
    readonly settingsPath: string;
    readonly keybindingsPath: string;
    readonly themePath: string;
    private readonly configDirectory: string;
    private settings = defaultSettings;
    private settingsSource = `${JSON.stringify(defaultSettings, null, 2)}\n`;
    private keybindings = defaultKeybindings;
    private keybindingsSource = `${JSON.stringify(defaultKeybindings, null, 2)}\n`;
    private theme: ThemeTokens = draculaTheme;
    private themeSource = serializeTheme(draculaTheme);
    private watcher?: WatcherSubscription;
    private readonly watchTimers = new Map<string, NodeJS.Timeout>();
    private readonly observedSources = new Map<string, string>();
    private readonly errors = new Map<ConfigurationKind, string>();
    private closed = false;

    constructor(
        userDataPath: string,
        private readonly emit: (event: RuntimeEvent) => void,
        private readonly logger?: StructuredLogger,
    ) {
        this.configDirectory = join(userDataPath, 'config');
        this.settingsPath = join(this.configDirectory, 'settings.jsonc');
        this.keybindingsPath = join(this.configDirectory, 'keybindings.jsonc');
        this.themePath = join(this.configDirectory, 'theme.json');
    }

    async initialize(): Promise<void> {
        await mkdir(dirname(this.settingsPath), { recursive: true });
        await this.loadOrCreate('settings');
        await this.loadOrCreate('keybindings');
        await this.loadOrCreate('theme');
        const watchedDirectory = await realpath(this.configDirectory);
        const onEvents: parcelWatcher.SubscribeCallback = (error, events) => {
            if (this.closed) return;
            if (error) {
                this.emitWatcherError(error);
                return;
            }
            for (const event of events) {
                const path = this.pathForWatcherEvent(watchedDirectory, event.path);
                if (path) this.scheduleExternalChange(path);
            }
        };
        const startedAt = performance.now();
        const backend = NATIVE_WATCHER_BACKEND;
        let selectedBackend: string = backend;
        try {
            this.watcher = await parcelWatcher.subscribe(watchedDirectory, onEvents, { backend });
        } catch (error) {
            /** Polling three known files avoids consuming another OS watcher when global FSEvents capacity is exhausted. */
            const timer = setInterval(() => {
                for (const path of [this.settingsPath, this.keybindingsPath, this.themePath]) {
                    void this.onExternalChange(path);
                }
            }, FALLBACK_POLL_INTERVAL_MS);
            timer.unref();
            this.watcher = {
                unsubscribe: () => {
                    clearInterval(timer);
                    return Promise.resolve();
                },
            };
            selectedBackend = 'poll';
            this.logger?.write('warn', 'configuration.watcher.fallback', {
                fields: {
                    backend,
                    error: errorMessage(error, 'unknown watcher error'),
                },
            });
        }
        this.logger?.write('info', 'configuration.watcher.ready', {
            durationMs: performance.now() - startedAt,
            fields: { backend: selectedBackend },
        });
    }

    private async loadOrCreate(kind: ConfigurationKind): Promise<void> {
        const path = this.pathFor(kind);
        let source: string;
        try {
            source = await readFile(path, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            source =
                kind === 'settings'
                    ? this.settingsSource
                    : kind === 'keybindings'
                      ? this.keybindingsSource
                      : this.themeSource;
            await atomicWrite(path, source);
            return;
        }
        try {
            this.apply(kind, source);
            this.errors.delete(kind);
        } catch (error) {
            const message = errorMessage(error, 'Configuration parse failed');
            this.errors.set(kind, message);
            this.logger?.write('warn', 'configuration.load_failed', {
                fields: { kind, error: message },
            });
            this.emitChange(kind, this.sourceFor(kind), message);
        }
    }

    private prepare(kind: ConfigurationKind, source: string): () => void {
        const path = this.pathFor(kind);
        try {
            if (kind === 'settings') {
                const settings = settingsSchema.parse(parseJsonc(source));
                return () => {
                    this.settings = settings;
                    this.settingsSource = source;
                };
            }
            if (kind === 'keybindings') {
                const keybindings = keybindingSchema.parse(parseJsonc(source));
                return () => {
                    this.keybindings = keybindings;
                    this.keybindingsSource = source;
                };
            }
            const theme = parseCaxriTheme(source);
            return () => {
                this.theme = theme;
                this.themeSource = source;
            };
        } catch (error) {
            throw new Error(
                `${basename(path)}: ${errorMessage(error, 'configuration parse failed')}`,
                {
                    cause: error,
                },
            );
        }
    }

    private apply(kind: ConfigurationKind, source: string): void {
        this.prepare(kind, source)();
    }

    private pathFor(kind: ConfigurationKind): string {
        return kind === 'settings'
            ? this.settingsPath
            : kind === 'keybindings'
              ? this.keybindingsPath
              : this.themePath;
    }

    private kindForPath(path: string): ConfigurationKind | undefined {
        if (path === this.settingsPath) return 'settings';
        if (path === this.keybindingsPath) return 'keybindings';
        if (path === this.themePath) return 'theme';
        return undefined;
    }

    private pathForWatcherEvent(watchedDirectory: string, eventPath: string): string | undefined {
        const relativePath = relative(watchedDirectory, eventPath);
        if (relativePath === basename(this.settingsPath)) return this.settingsPath;
        if (relativePath === basename(this.keybindingsPath)) return this.keybindingsPath;
        if (relativePath === basename(this.themePath)) return this.themePath;
        return undefined;
    }

    private sourceFor(kind: ConfigurationKind): string {
        return kind === 'settings'
            ? this.settingsSource
            : kind === 'keybindings'
              ? this.keybindingsSource
              : this.themeSource;
    }

    private emitChange(kind: ConfigurationKind, source: string, error?: string): void {
        const payload = error ? { source, error } : { source };
        if (kind === 'settings') this.emit({ event: 'settings.changed', payload });
        else if (kind === 'keybindings') this.emit({ event: 'keybindings.changed', payload });
        else this.emit({ event: 'theme.changed', payload });
    }

    private scheduleExternalChange(path: string): void {
        const pending = this.watchTimers.get(path);
        if (pending) clearTimeout(pending);
        this.watchTimers.set(
            path,
            setTimeout(() => {
                this.watchTimers.delete(path);
                void this.onExternalChange(path);
            }, WATCH_SETTLE_DELAY_MS),
        );
    }

    private async onExternalChange(path: string): Promise<void> {
        const kind = this.kindForPath(path);
        if (!kind) return;
        try {
            const source = await readFile(path, 'utf8');
            if (source === this.observedSources.get(path)) return;
            this.observedSources.set(path, source);
            if (source === this.sourceFor(kind)) return;
            this.apply(kind, source);
            this.errors.delete(kind);
            this.emitChange(kind, source);
        } catch (error) {
            const message = errorMessage(error, 'Configuration parse failed');
            this.errors.set(kind, message);
            this.emitChange(kind, this.sourceFor(kind), message);
        }
    }

    private emitWatcherError(error: Error): void {
        const message = `Configuration watcher failed: ${error.message}`;
        this.logger?.write('warn', 'configuration.watcher.error', {
            fields: { error: error.message },
        });
        for (const kind of ['settings', 'keybindings', 'theme'] satisfies ConfigurationKind[]) {
            this.emitChange(kind, this.sourceFor(kind), message);
        }
    }

    private async update(kind: ConfigurationKind, source: string): Promise<void> {
        const commit = this.prepare(kind, source);
        await atomicWrite(this.pathFor(kind), source);
        commit();
        this.errors.delete(kind);
        this.emitChange(kind, source);
    }

    getErrors(): string[] {
        return [...this.errors.values()];
    }

    getSettings(): { value: AppSettings; source: string } {
        return { value: this.settings, source: this.settingsSource };
    }

    getKeybindings(): { value: Keybinding[]; source: string; conflicts: KeybindingConflict[] } {
        return {
            value: this.keybindings,
            source: this.keybindingsSource,
            conflicts: findKeybindingConflicts(this.keybindings),
        };
    }

    getTheme(): { value: ThemeTokens; source: string } {
        return { value: this.theme, source: this.themeSource };
    }

    updateSettings(source: string): Promise<void> {
        return this.update('settings', source);
    }

    updateKeybindings(source: string): Promise<void> {
        return this.update('keybindings', source);
    }

    updateTheme(source: string): Promise<void> {
        return this.update('theme', source);
    }

    async importTheme(path: string): Promise<ThemeTokens> {
        const theme = await importTheme(path, this.theme);
        await this.update('theme', serializeTheme(theme));
        return theme;
    }

    async close(): Promise<void> {
        this.closed = true;
        for (const timer of this.watchTimers.values()) clearTimeout(timer);
        this.watchTimers.clear();
        const watcher = this.watcher;
        this.watcher = undefined;
        await watcher?.unsubscribe();
    }
}

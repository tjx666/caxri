import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import parcelWatcher from '@parcel/watcher';
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { z } from 'zod';

import type { RuntimeEvent } from '../shared/contracts';
import type { AppSettings, Keybinding, KeybindingConflict, ThemeTokens } from '../shared/types';
import type { StructuredLogger } from './logger';
import { NATIVE_WATCHER_BACKEND } from './native-watcher';
import { draculaTheme, importTheme, parseCaxriTheme, serializeTheme } from './theme';

type ConfigurationKind = 'settings' | 'keybindings' | 'theme';

interface WatcherSubscription {
    unsubscribe(): Promise<void>;
}

const WATCH_SETTLE_DELAY_MS = 100;
const FALLBACK_POLL_INTERVAL_MS = 250;

const settingsSchema = z.object({
    'session.defaultAgent': z.enum(['claude', 'codex', 'shell']).nullable().default(null),
    'terminal.fontSize': z.number().int().min(9).max(32).default(13),
    'terminal.scrollback': z.number().int().min(100).max(10_000).default(2_000),
    'files.maxFileBytes': z
        .number()
        .int()
        .min(1_024)
        .max(16 * 1024 * 1024)
        .default(2 * 1024 * 1024),
});

const keybindingSchema = z.array(
    z.object({ key: z.string().min(1).max(100), command: z.string().min(1).max(200) }),
);

const defaultSettings: AppSettings = {
    'session.defaultAgent': null,
    'terminal.fontSize': 13,
    'terminal.scrollback': 2_000,
    'files.maxFileBytes': 2 * 1024 * 1024,
};

export const defaultKeybindings: Keybinding[] = [
    { key: 'cmd+shift+p', command: 'commandPalette.open' },
    { key: 'cmd+n', command: 'session.create' },
    { key: 'cmd+t', command: 'terminal.new' },
    { key: 'cmd+shift+r', command: 'terminal.restart' },
    { key: 'cmd+w', command: 'terminal.close' },
    { key: 'cmd+s', command: 'editor.save' },
    { key: 'cmd+1', command: 'inspector.showFiles' },
    { key: 'cmd+2', command: 'inspector.showGit' },
    { key: 'cmd+3', command: 'inspector.showAgent' },
    { key: 'cmd+,', command: 'theme.openSettings' },
];

function parseJsonc(source: string): unknown {
    const errors: ParseError[] = [];
    const value: unknown = parse(source, errors, {
        allowTrailingComma: true,
        disallowComments: false,
    });
    if (errors.length > 0) {
        const first = errors[0];
        const before = source.slice(0, first.offset).split('\n');
        throw new Error(
            `${printParseErrorCode(first.error)} at line ${before.length}, column ${(before.at(-1)?.length ?? 0) + 1}`,
        );
    }
    return value;
}

async function atomicWrite(path: string, source: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
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
    return [...byKey.entries()]
        .filter(([, commands]) => commands.size > 1)
        .map(([key, commands]) => ({ key, commands: [...commands] }));
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
                    error: error instanceof Error ? error.message : 'unknown watcher error',
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
            const message = error instanceof Error ? error.message : 'Configuration parse failed';
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
                `${basename(path)}: ${error instanceof Error ? error.message : 'configuration parse failed'}`,
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
            const message = error instanceof Error ? error.message : 'Configuration parse failed';
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

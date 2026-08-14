import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import parcelWatcher from '@parcel/watcher';
import { applyEdits, modify } from 'jsonc-parser';

import { defaultAgentProviderSettings } from '../shared/agents';
import { defaultKeybindings } from '../shared/commands';
import {
    configurationSourceSchema,
    MAX_CONFIGURATION_SOURCE_BYTES,
} from '../shared/configuration-contract';
import {
    findKeybindingConflicts,
    keybindingsFileSchema,
    settingsFileSchema,
} from '../shared/configuration';
import { CaxriError, errorMessage } from '../shared/ipc/errors';
import {
    inspectableSettingsSchema,
    type SettingsPatchChange,
    type SettingsPatchResult,
} from '../shared/ipc/business-contract';
import type { RuntimeEvent } from '../shared/ipc/events';
import { parseJsonc } from '../shared/node/jsonc';
import type { StructuredLogger } from '../shared/node/logger';
import { redactLogValue } from '../shared/node/redaction';
import {
    DEFAULT_FILES_EXCLUDE,
    SETTINGS_BOUNDS,
    type AppSettings,
    type Keybinding,
    type KeybindingConflict,
    type ThemeTokens,
} from '../shared/types';
import { MAX_TRUSTED_DOMAINS, normalizeTrustedDomainRule } from '../shared/trusted-domains';
import { NATIVE_WATCHER_BACKEND } from './native-watcher';
import { draculaTheme, importTheme, parseCaxriTheme, serializeTheme } from './theme';

type ConfigurationKind = 'settings' | 'keybindings' | 'theme';

interface WatcherSubscription {
    unsubscribe(): Promise<void>;
}

interface PreparedConfiguration {
    apply(): void;
    source: string;
}

class ConfigurationSourceReadError extends Error {
    constructor(
        message: string,
        readonly revision: string,
    ) {
        super(message);
        this.name = 'ConfigurationSourceReadError';
    }
}

const WATCH_SETTLE_DELAY_MS = 100;
const FALLBACK_POLL_INTERVAL_MS = 250;
const JSONC_FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true, eol: '\n' };
const originalDefaultKeybindings: Keybinding[] = [
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
/**
 * The defaults shipped immediately before Terminal Copy and tab cycling were added and
 * `pathBrowser.open` moved off `Cmd+P`. Each historical set below is derived from the one after it,
 * so a new default has to be stripped here as well — otherwise every older set would also claim to
 * contain bindings that release never had, and no untouched file would match any of them.
 */
const preTerminalCopyDefaultKeybindings = defaultKeybindings.flatMap((binding) => {
    if (['terminal.copy', 'workbench.nextTab', 'workbench.previousTab'].includes(binding.command))
        return [];
    return binding.command === 'pathBrowser.open' ? [{ ...binding, key: 'cmd+p' }] : [binding];
});
const preCommandNavigationDefaultKeybindings = preTerminalCopyDefaultKeybindings.filter(
    (binding) => !['terminal.previousCommand', 'terminal.nextCommand'].includes(binding.command),
);
const previousDefaultKeybindings = preCommandNavigationDefaultKeybindings.filter(
    (binding) => binding.command !== 'terminal.find',
);
const prePathBrowserDefaultKeybindings = previousDefaultKeybindings.filter(
    (binding) => binding.command !== 'pathBrowser.open',
);
const closeTerminalDefaultKeybindings = prePathBrowserDefaultKeybindings.map((binding) =>
    binding.command === 'workbench.closeActiveTab'
        ? { ...binding, command: 'terminal.close' }
        : binding,
);
const newlyAddedDefaultCommands = new Set([
    'inspector.searchFiles',
    'inspector.toggle',
    'sidebar.toggle',
]);
/**
 * Every historical default set {@link migrateLegacyDefaultKeybindings} still recognizes as
 * untouched. Exported so tests can drive the migration from the real derivation chain: a test that
 * rebuilds a past release by filtering the *current* catalog silently rots the moment a default is
 * added or rebound, because the fixture then contains chords that release never shipped.
 */
export const previousDefaultKeybindingSets = [
    preTerminalCopyDefaultKeybindings,
    preCommandNavigationDefaultKeybindings,
    previousDefaultKeybindings,
    prePathBrowserDefaultKeybindings,
    originalDefaultKeybindings,
    closeTerminalDefaultKeybindings,
    closeTerminalDefaultKeybindings.filter(
        (binding) => !['inspector.toggle', 'sidebar.toggle'].includes(binding.command),
    ),
    closeTerminalDefaultKeybindings.filter(
        (binding) => !newlyAddedDefaultCommands.has(binding.command),
    ),
];

interface ConfigurationServiceOptions {
    /** Overrides the fallback watcher cadence for deterministic integration tests. */
    fallbackPollIntervalMs?: number;
}

/** Upgrades known untouched historical defaults while preserving every customized keybinding file. */
function migrateLegacyDefaultKeybindings(keybindings: Keybinding[]): Keybinding[] {
    const source = JSON.stringify(keybindings);
    return previousDefaultKeybindingSets.some((defaults) => source === JSON.stringify(defaults))
        ? defaultKeybindings
        : keybindings;
}

const defaultSettings: AppSettings = {
    'session.defaultAgent': null,
    'workbench.newWorktreeBehavior': 'ask',
    'agents.providers': structuredClone(defaultAgentProviderSettings),
    'security.trustedDomains': [],
    'terminal.defaultWorkingDirectory': null,
    'terminal.fontSize': SETTINGS_BOUNDS['terminal.fontSize'].default,
    'terminal.scrollback': SETTINGS_BOUNDS['terminal.scrollback'].default,
    'terminal.copyOnSelect': SETTINGS_BOUNDS['terminal.copyOnSelect'].default,
    'terminal.gpuAcceleration': SETTINGS_BOUNDS['terminal.gpuAcceleration'].default,
    'terminal.osc52ClipboardWrite': SETTINGS_BOUNDS['terminal.osc52ClipboardWrite'].default,
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

async function readBoundedConfigurationSource(path: string): Promise<string> {
    const file = await open(path, 'r');
    try {
        const metadata = await file.stat();
        const revision = [
            metadata.dev,
            metadata.ino,
            metadata.size,
            metadata.mtimeMs,
            metadata.ctimeMs,
        ].join(':');
        if (!metadata.isFile()) {
            throw new ConfigurationSourceReadError(
                'Configuration source is not a regular file',
                revision,
            );
        }
        if (metadata.size > MAX_CONFIGURATION_SOURCE_BYTES) {
            throw new ConfigurationSourceReadError(
                `Configuration source exceeds the ${MAX_CONFIGURATION_SOURCE_BYTES} byte configuration source limit`,
                revision,
            );
        }

        /** The extra byte detects growth between stat and read without loading the full file. */
        const buffer = Buffer.allocUnsafe(MAX_CONFIGURATION_SOURCE_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        if (bytesRead > MAX_CONFIGURATION_SOURCE_BYTES) {
            throw new ConfigurationSourceReadError(
                `Configuration source exceeds the ${MAX_CONFIGURATION_SOURCE_BYTES} byte configuration source limit`,
                revision,
            );
        }
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        await file.close();
    }
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
    private readonly rejectedSourceRevisions = new Map<string, string>();
    private readonly errors = new Map<ConfigurationKind, string>();
    private readonly settingsListeners = new Set<(settings: AppSettings) => void>();
    private settingsMutationTail: Promise<void> = Promise.resolve();
    private closed = false;
    private readonly fallbackPollIntervalMs: number;

    constructor(
        userDataPath: string,
        private readonly emit: (event: RuntimeEvent) => void,
        private readonly logger?: StructuredLogger,
        options: ConfigurationServiceOptions = {},
    ) {
        this.fallbackPollIntervalMs = options.fallbackPollIntervalMs ?? FALLBACK_POLL_INTERVAL_MS;
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
            }, this.fallbackPollIntervalMs);
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
            source = await readBoundedConfigurationSource(path);
            this.rejectedSourceRevisions.delete(path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                source = this.sourceFor(kind);
                await atomicWrite(path, source);
                return;
            }
            this.rememberRejectedSource(path, error);
            this.recordConfigurationError(kind, error);
            return;
        }
        try {
            const prepared = this.prepare(kind, source);
            if (prepared.source !== source) await atomicWrite(path, prepared.source);
            prepared.apply();
            this.observedSources.set(path, prepared.source);
            this.errors.delete(kind);
        } catch (error) {
            this.recordConfigurationError(kind, error);
        }
    }

    private recordConfigurationError(kind: ConfigurationKind, error: unknown): void {
        const fileName = basename(this.pathFor(kind));
        const detail = errorMessage(error, 'Configuration load failed');
        const message = detail.startsWith(`${fileName}:`) ? detail : `${fileName}: ${detail}`;
        this.errors.set(kind, message);
        this.logger?.write('warn', 'configuration.load_failed', {
            fields: { kind, error: message },
        });
        this.emitChange(kind, this.sourceFor(kind), message);
    }

    /** Suppresses repeated polling errors without retaining any rejected source bytes. */
    private rememberRejectedSource(path: string, error: unknown): boolean {
        if (!(error instanceof ConfigurationSourceReadError)) {
            this.rejectedSourceRevisions.delete(path);
            return false;
        }
        const repeated = this.rejectedSourceRevisions.get(path) === error.revision;
        this.rejectedSourceRevisions.set(path, error.revision);
        return repeated;
    }

    private prepare(kind: ConfigurationKind, source: string): PreparedConfiguration {
        const path = this.pathFor(kind);
        try {
            configurationSourceSchema.parse(source);
            if (kind === 'settings') {
                const settings = settingsFileSchema.parse(parseJsonc(source));
                return {
                    source,
                    apply: () => {
                        this.settings = settings;
                        this.settingsSource = source;
                    },
                };
            }
            if (kind === 'keybindings') {
                const parsed = keybindingsFileSchema.parse(parseJsonc(source));
                const keybindings = migrateLegacyDefaultKeybindings(parsed);
                const normalizedSource =
                    keybindings === parsed ? source : `${JSON.stringify(keybindings, null, 2)}\n`;
                return {
                    source: normalizedSource,
                    apply: () => {
                        this.keybindings = keybindings;
                        this.keybindingsSource = normalizedSource;
                    },
                };
            }
            const theme = parseCaxriTheme(source);
            return {
                source,
                apply: () => {
                    this.theme = theme;
                    this.themeSource = source;
                },
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
            const source = await readBoundedConfigurationSource(path);
            this.rejectedSourceRevisions.delete(path);
            if (source === this.observedSources.get(path)) return;
            this.observedSources.set(path, source);
            const prepared = this.prepare(kind, source);
            if (prepared.source !== source) {
                await atomicWrite(path, prepared.source);
                this.observedSources.set(path, prepared.source);
            }
            if (prepared.source === this.sourceFor(kind)) return;
            prepared.apply();
            this.errors.delete(kind);
            this.emitChange(kind, prepared.source);
            if (kind === 'settings') this.notifySettings();
        } catch (error) {
            if (this.rememberRejectedSource(path, error)) return;
            this.recordConfigurationError(kind, error);
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
        const prepared = this.prepare(kind, source);
        const path = this.pathFor(kind);
        await atomicWrite(path, prepared.source);
        this.observedSources.set(path, prepared.source);
        this.rejectedSourceRevisions.delete(path);
        prepared.apply();
        this.errors.delete(kind);
        this.emitChange(kind, prepared.source);
        if (kind === 'settings') this.notifySettings();
    }

    getErrors(): string[] {
        return [...this.errors.values()];
    }

    getSettings(): { value: AppSettings; source: string } {
        return { value: this.settings, source: this.settingsSource };
    }

    private settingsInspection(source: string, value: AppSettings) {
        return {
            value: inspectableSettingsSchema.parse(value),
            revision: createHash('sha256').update(source).digest('hex'),
            errors: this.getErrors().map((error) => redactLogValue(error)),
        };
    }

    inspectSettings() {
        return this.settingsInspection(this.settingsSource, this.settings);
    }

    /** Applies a field-bounded patch through the same schema and atomic update path as Desktop. */
    patchSettings(
        changes: readonly SettingsPatchChange[],
        dryRun: boolean,
    ): Promise<SettingsPatchResult> {
        return this.mutateSettings(async () => {
            const candidate = { ...this.settings } as Record<string, unknown>;
            for (const change of changes) candidate[change.key] = change.value;
            const value = settingsFileSchema.parse(candidate);
            const changedKeys = [...new Set(changes.map(({ key }) => key))].filter(
                (key) => JSON.stringify(this.settings[key]) !== JSON.stringify(value[key]),
            );
            let source = this.settingsSource;
            for (const key of changedKeys)
                source = applyEdits(
                    source,
                    modify(source, [key], value[key], {
                        formattingOptions: JSONC_FORMATTING_OPTIONS,
                    }),
                );
            this.prepare('settings', source);
            if (!dryRun && changedKeys.length > 0) await this.update('settings', source);
            const inspection = dryRun
                ? this.settingsInspection(source, value)
                : this.inspectSettings();
            return { ...inspection, dryRun, changedKeys };
        });
    }

    subscribeSettings(listener: (settings: AppSettings) => void): () => void {
        this.settingsListeners.add(listener);
        return () => this.settingsListeners.delete(listener);
    }

    private notifySettings(): void {
        for (const listener of this.settingsListeners) listener(this.settings);
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

    /** Serializes read-modify-write Settings operations so concurrent trust prompts cannot lose rules. */
    private mutateSettings<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.settingsMutationTail.then(operation);
        this.settingsMutationTail = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }

    updateSettings(source: string): Promise<void> {
        return this.mutateSettings(() => this.update('settings', source));
    }

    trustDomain(input: string): Promise<void> {
        return this.mutateSettings(async () => {
            const domain = normalizeTrustedDomainRule(input);
            if (!domain) throw new CaxriError('VALIDATION', 'Invalid trusted domain');
            const current = this.settings['security.trustedDomains'];
            if (current.includes(domain)) return;
            if (current.length >= MAX_TRUSTED_DOMAINS)
                throw new CaxriError(
                    'CAPACITY',
                    `Trusted Domains supports at most ${MAX_TRUSTED_DOMAINS} rules`,
                );
            const source = applyEdits(
                this.settingsSource,
                modify(this.settingsSource, ['security.trustedDomains'], [...current, domain], {
                    formattingOptions: JSONC_FORMATTING_OPTIONS,
                }),
            );
            await this.update('settings', source);
        });
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
        this.settingsListeners.clear();
        const watcher = this.watcher;
        this.watcher = undefined;
        await watcher?.unsubscribe();
    }
}

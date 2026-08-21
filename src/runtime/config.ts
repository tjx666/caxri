import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import { applyEdits, modify } from 'jsonc-parser';

import { defaultKeybindings } from '../shared/commands';
import {
    appSettingsFileSchema,
    defaultAppSettings,
    findKeybindingConflicts,
    keybindingsFileSchema,
} from '../shared/config';
import {
    configurationSourceSchema as configSourceSchema,
    MAX_CONFIGURATION_SOURCE_BYTES,
} from '../shared/config-contract';
import type { SettingsPatchChange, SettingsPatchResult } from '../shared/ipc/business-contract';
import { inspectableSettingsSchema } from '../shared/ipc/business-contract';
import { CaxriError, errorMessage } from '../shared/ipc/errors';
import type { RuntimeEvent } from '../shared/ipc/events';
import { parseJsonc } from '../shared/node/jsonc';
import type { StructuredLogger } from '../shared/node/logger';
import { redactLogValue } from '../shared/node/redaction';
import { MAX_TRUSTED_DOMAINS, normalizeTrustedDomainRule } from '../shared/trusted-domains';
import type { AppSettings, Keybinding, KeybindingConflict, ThemeTokens } from '../shared/types';
import { atomicWrite } from './atomic-file';
import { draculaTheme, importTheme, parseCaxriTheme, serializeTheme } from './theme';
import type { WatchHandle } from './watch-hub';
import { WatchHub } from './watch-hub';

type ConfigKind = 'settings' | 'keybindings' | 'theme';

interface PreparedConfig {
    apply(): void;
    source: string;
}

class ConfigSourceReadError extends Error {
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
 * The untouched defaults immediately before Session MRU switching gained its own configurable shortcut.
 */
const preSessionMruDefaultKeybindings = defaultKeybindings.filter(
    (binding) => binding.command !== 'session.switchMru',
);
/**
 * The defaults shipped while Info was still an Inspector tab on `Cmd+4`, before Info and Logs moved to the Bottom
 * Panel.
 *
 * Every other historical set is derived by _removing_ commands from the current catalog, which works only while ids
 * survive. `inspector.showInfo` was retired by that move, so this set has to reinstate it explicitly — otherwise no
 * untouched pre-move file matches any known default set and every existing profile silently keeps a keybinding table
 * that has no `Cmd+J` and still names a command that no longer exists.
 */
const preBottomPanelDefaultKeybindings: Keybinding[] = preSessionMruDefaultKeybindings.flatMap(
    (binding) => {
        if (binding.command.startsWith('bottomPanel.')) return [];
        return binding.command === 'inspector.showStatus'
            ? [binding, { key: 'cmd+4', command: 'inspector.showInfo' }]
            : [binding];
    },
);
/**
 * The defaults shipped while "Add Project" was still bound to `Cmd+N`, before it moved to the macOS-conventional
 * `Cmd+O`.
 */
const preProjectOpenDefaultKeybindings = preBottomPanelDefaultKeybindings.map((binding) =>
    binding.command === 'project.create' ? { ...binding, key: 'cmd+n' } : binding,
);
/**
 * The defaults shipped immediately before Terminal Copy and tab cycling were added and `pathBrowser.open` moved off
 * `Cmd+P`. Each historical set below is derived from the one after it, so a new default has to be stripped here as well
 * — otherwise every older set would also claim to contain bindings that release never had, and no untouched file would
 * match any of them.
 */
const preTerminalCopyDefaultKeybindings = preProjectOpenDefaultKeybindings.flatMap((binding) => {
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
 * Every historical default set {@link migrateLegacyDefaultKeybindings} still recognizes as untouched. Exported so tests
 * can drive the migration from the real derivation chain: a test that rebuilds a past release by filtering the
 * _current_ catalog silently rots the moment a default is added or rebound, because the fixture then contains chords
 * that release never shipped.
 */
export const previousDefaultKeybindingSets = [
    preSessionMruDefaultKeybindings,
    preBottomPanelDefaultKeybindings,
    preProjectOpenDefaultKeybindings,
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

interface ConfigServiceOptions {
    /**
     * Overrides the fallback watcher cadence for deterministic integration tests.
     */
    fallbackPollIntervalMs?: number;
    /**
     * Shared Runtime watch registry. Production passes the Runtime-wide hub; tests may omit it, in which case the
     * service owns a private hub with equivalent behavior.
     */
    watchHub?: WatchHub;
}

/**
 * Upgrades known untouched historical defaults while preserving every customized keybinding file.
 */
function migrateLegacyDefaultKeybindings(keybindings: Keybinding[]): Keybinding[] {
    const source = JSON.stringify(keybindings);
    return previousDefaultKeybindingSets.some((defaults) => source === JSON.stringify(defaults))
        ? defaultKeybindings
        : keybindings;
}

async function readBoundedConfigSource(path: string): Promise<string> {
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
            throw new ConfigSourceReadError('Configuration source is not a regular file', revision);
        }
        if (metadata.size > MAX_CONFIGURATION_SOURCE_BYTES) {
            throw new ConfigSourceReadError(
                `Configuration source exceeds the ${MAX_CONFIGURATION_SOURCE_BYTES} byte configuration source limit`,
                revision,
            );
        }

        /**
         * The extra byte detects growth between stat and read without loading the full file.
         */
        const buffer = Buffer.allocUnsafe(MAX_CONFIGURATION_SOURCE_BYTES + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.length) {
            // Each read's offset depends on the byte count already read, so the reads are
            // inherently sequential and cannot be batched with Promise.all.
            // eslint-disable-next-line no-await-in-loop -- sequential-by-offset read, see comment above
            const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        if (bytesRead > MAX_CONFIGURATION_SOURCE_BYTES) {
            throw new ConfigSourceReadError(
                `Configuration source exceeds the ${MAX_CONFIGURATION_SOURCE_BYTES} byte configuration source limit`,
                revision,
            );
        }
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        await file.close();
    }
}

export class ConfigService {
    private readonly configDirectory: string;
    private settings: AppSettings = structuredClone(defaultAppSettings);
    private settingsSource = `${JSON.stringify(defaultAppSettings, null, 2)}\n`;
    private keybindings = defaultKeybindings;
    private keybindingsSource = `${JSON.stringify(defaultKeybindings, null, 2)}\n`;
    private theme: ThemeTokens = draculaTheme;
    private themeSource = serializeTheme(draculaTheme);
    private watchHandle?: WatchHandle;
    private readonly watchHub: WatchHub;
    private readonly ownsWatchHub: boolean;
    private readonly watchTimers = new Map<string, NodeJS.Timeout>();
    private readonly observedSources = new Map<string, string>();
    private readonly rejectedSourceRevisions = new Map<string, string>();
    private readonly errors = new Map<ConfigKind, string>();
    private readonly settingsListeners = new Set<(settings: AppSettings) => void>();
    private settingsMutationTail: Promise<void> = Promise.resolve();
    private closed = false;
    private readonly fallbackPollIntervalMs: number;
    readonly settingsPath: string;
    readonly keybindingsPath: string;
    readonly themePath: string;

    constructor(
        userDataPath: string,
        private readonly emit: (event: RuntimeEvent) => void,
        private readonly logger?: StructuredLogger,
        options: ConfigServiceOptions = {},
    ) {
        this.fallbackPollIntervalMs = options.fallbackPollIntervalMs ?? FALLBACK_POLL_INTERVAL_MS;
        this.ownsWatchHub = !options.watchHub;
        this.watchHub = options.watchHub ?? new WatchHub({ logger });
        this.configDirectory = join(userDataPath, 'config');
        this.settingsPath = join(this.configDirectory, 'settings.jsonc');
        this.keybindingsPath = join(this.configDirectory, 'keybindings.jsonc');
        this.themePath = join(this.configDirectory, 'theme.json');
    }

    private async loadOrCreate(kind: ConfigKind): Promise<void> {
        const path = this.pathFor(kind);
        let source: string;
        try {
            source = await readBoundedConfigSource(path);
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

    private recordConfigurationError(kind: ConfigKind, error: unknown): void {
        const fileName = basename(this.pathFor(kind));
        const detail = errorMessage(error, 'Configuration load failed');
        const message = detail.startsWith(`${fileName}:`) ? detail : `${fileName}: ${detail}`;
        this.errors.set(kind, message);
        this.logger?.write('warn', 'configuration.load_failed', {
            fields: { kind, error: message },
        });
        this.emitChange(kind, this.sourceFor(kind), message);
    }

    /**
     * Suppresses repeated polling errors without retaining any rejected source bytes.
     */
    private rememberRejectedSource(path: string, error: unknown): boolean {
        if (!(error instanceof ConfigSourceReadError)) {
            this.rejectedSourceRevisions.delete(path);
            return false;
        }
        const isRepeated = this.rejectedSourceRevisions.get(path) === error.revision;
        this.rejectedSourceRevisions.set(path, error.revision);
        return isRepeated;
    }

    private prepare(kind: ConfigKind, source: string): PreparedConfig {
        const path = this.pathFor(kind);
        try {
            configSourceSchema.parse(source);
            if (kind === 'settings') {
                const settings = appSettingsFileSchema.parse(parseJsonc(source));
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

    private pathFor(kind: ConfigKind): string {
        return kind === 'settings'
            ? this.settingsPath
            : kind === 'keybindings'
              ? this.keybindingsPath
              : this.themePath;
    }

    private kindForPath(path: string): ConfigKind | undefined {
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

    private sourceFor(kind: ConfigKind): string {
        return kind === 'settings'
            ? this.settingsSource
            : kind === 'keybindings'
              ? this.keybindingsSource
              : this.themeSource;
    }

    private emitChange(kind: ConfigKind, source: string, error?: string): void {
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
                // `setTimeout`'s callback is synchronous, so this cannot become `await`; see the
                // fallback-poll callback above for why `.catch()` is used instead.
                // eslint-disable-next-line unicorn/prefer-await -- sync timer callback, see comment above
                this.onExternalChange(path).catch((error: unknown) =>
                    this.logger?.write('error', 'configuration.watch_change_failed', {
                        fields: { path, error: errorMessage(error, 'unknown') },
                    }),
                );
            }, WATCH_SETTLE_DELAY_MS),
        );
    }

    private async onExternalChange(path: string): Promise<void> {
        const kind = this.kindForPath(path);
        if (!kind) return;
        try {
            const source = await readBoundedConfigSource(path);
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
        for (const kind of ['settings', 'keybindings', 'theme'] satisfies ConfigKind[]) {
            this.emitChange(kind, this.sourceFor(kind), message);
        }
    }

    private async update(kind: ConfigKind, source: string): Promise<void> {
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

    private settingsInspection(source: string, value: AppSettings) {
        return {
            value: inspectableSettingsSchema.parse(value),
            revision: createHash('sha256').update(source).digest('hex'),
            errors: this.getErrors().map((error) => redactLogValue(error)),
        };
    }

    private notifySettings(): void {
        for (const listener of this.settingsListeners) listener(this.settings);
    }

    /**
     * Serializes read-modify-write Settings operations so concurrent trust prompts cannot lose rules.
     */
    private mutateSettings<T>(operation: () => Promise<T>): Promise<T> {
        const previousTail = this.settingsMutationTail;
        const result = (async () => {
            await previousTail;
            return operation();
        })();
        this.settingsMutationTail = (async () => {
            try {
                await result;
            } catch {
                // Swallow so a failed mutation still lets queued mutations run.
            }
        })();
        return result;
    }

    private async pollConfigSourcesOnce(): Promise<void> {
        await Promise.all(
            [this.settingsPath, this.keybindingsPath, this.themePath].map(async (path) => {
                try {
                    await this.onExternalChange(path);
                } catch (error) {
                    this.logger?.write('error', 'configuration.poll_change_failed', {
                        fields: { path, error: errorMessage(error, 'unknown') },
                    });
                }
            }),
        );
    }

    async initialize(): Promise<void> {
        await mkdir(dirname(this.settingsPath), { recursive: true });
        await this.loadOrCreate('settings');
        await this.loadOrCreate('keybindings');
        await this.loadOrCreate('theme');
        const watchedDirectory = await realpath(this.configDirectory);
        const startedAt = performance.now();
        this.watchHandle = await this.watchHub.register({
            label: 'config',
            root: watchedDirectory,
            onEvents: (events) => {
                if (this.closed) return;
                for (const event of events) {
                    const path = this.pathForWatcherEvent(watchedDirectory, event.path);
                    if (path) this.scheduleExternalChange(path);
                }
            },
            onError: (error) => {
                if (this.closed) return;
                this.emitWatcherError(
                    error instanceof Error
                        ? error
                        : new Error(errorMessage(error, 'unknown watcher error')),
                );
            },
            /**
             * Polling three known files avoids consuming another OS watcher when global FSEvents capacity is exhausted.
             */
            fallback: {
                intervalMs: this.fallbackPollIntervalMs,
                pollOnce: () => this.pollConfigSourcesOnce(),
            },
        });
        this.logger?.write('info', 'configuration.watcher.ready', {
            durationMs: performance.now() - startedAt,
            fields: { backend: this.watchHandle.mode },
        });
    }

    getErrors(): string[] {
        return this.errors.values().toArray();
    }

    getSettings(): { value: AppSettings; source: string } {
        return { value: this.settings, source: this.settingsSource };
    }

    inspectSettings() {
        return this.settingsInspection(this.settingsSource, this.settings);
    }

    /**
     * Applies a field-bounded patch through the same schema and atomic update path as Desktop.
     */
    patchSettings(
        changes: readonly SettingsPatchChange[],
        isDryRun: boolean,
    ): Promise<SettingsPatchResult> {
        return this.mutateSettings(async () => {
            const candidate = { ...this.settings } as Record<string, unknown>;
            for (const change of changes) candidate[change.key] = change.value;
            const value = appSettingsFileSchema.parse(candidate);
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
            if (!isDryRun && changedKeys.length > 0) await this.update('settings', source);
            const inspection = isDryRun
                ? this.settingsInspection(source, value)
                : this.inspectSettings();
            return { ...inspection, dryRun: isDryRun, changedKeys };
        });
    }

    subscribeSettings(listener: (settings: AppSettings) => void): () => void {
        this.settingsListeners.add(listener);
        return () => this.settingsListeners.delete(listener);
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
        const handle = this.watchHandle;
        this.watchHandle = undefined;
        await handle?.dispose();
        if (this.ownsWatchHub) await this.watchHub.close();
    }
}

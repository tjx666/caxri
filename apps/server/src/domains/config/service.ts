import { createHash } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';

import type {
    AgentActionRecentSettings,
    AgentDelegationSettings,
    AgentProvider,
    AppSettings,
    Keybinding,
    KeybindingConflict,
    ServerEvent,
    SettingsPatchChange,
    SettingsPatchResult,
    ThemeImportWarning,
    ThemeTokens,
} from '@caxri/protocol';
import {
    agentDelegationSettingsSchema,
    appSettingsFileSchema,
    CaxriError,
    configurationSourceSchema as configSourceSchema,
    defaultAppSettings,
    defaultKeybindings,
    errorMessage,
    findKeybindingConflicts,
    inspectableSettingsSchema,
    MAX_TRUSTED_DOMAINS,
    MAX_TRUSTED_FOLDERS,
    normalizeTrustedDomainRule,
    normalizeTrustedFolderRule,
    pushRecentAgentAction,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, redactLogValue } from '@caxri/system';
import { notifyListeners } from '@caxri/utils';
import { applyEdits, modify } from 'jsonc-parser';

import { atomicWrite } from '../atomic-file';
import { draculaTheme, importTheme, serializeTheme } from '../theme';
import type { WatchHandle } from '../watch';
import { WatchHub } from '../watch';
import { preserveRecentAgentActions } from './recent-agent-actions';
import {
    JSONC_FORMATTING_OPTIONS,
    prepareKeybindingsSource,
    prepareSettingsSource,
    prepareThemeSource,
} from './reconcile';
import { ConfigSourceReadError, readBoundedConfigSource } from './source';

type ConfigKind = 'settings' | 'keybindings' | 'theme';

interface PreparedConfig {
    apply(): void;
    source: string;
}

const WATCH_SETTLE_DELAY_MS = 100;
const FALLBACK_POLL_INTERVAL_MS = 250;
interface ConfigServiceOptions {
    /**
     * Overrides the fallback watcher cadence for deterministic integration tests.
     */
    fallbackPollIntervalMs?: number;
    /**
     * Controlled filesystem seam for lifecycle tests; production retains the bounded reader.
     */
    readConfigSource?: (path: string) => Promise<string>;
    /**
     * Shared Server watch registry. Production passes the Server-wide hub; tests may omit it, in which case the service
     * owns a private hub with equivalent behavior.
     */
    watchHub?: WatchHub;
    /**
     * Controlled filesystem seam for lifecycle tests; production retains atomic replacement.
     */
    writeConfigSource?: (path: string, source: string) => Promise<void>;
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
    private createdSettingsThisRun = false;
    private closePromise?: Promise<void>;
    private readonly fallbackPollIntervalMs: number;
    private readonly readConfigSource: (path: string) => Promise<string>;
    private readonly writeConfigSource: (path: string, source: string) => Promise<void>;
    readonly settingsPath: string;
    readonly keybindingsPath: string;
    readonly themePath: string;

    constructor(
        userDataPath: string,
        private readonly emit: (event: ServerEvent) => void,
        private readonly logger?: StructuredLogger,
        options: ConfigServiceOptions = {},
    ) {
        this.fallbackPollIntervalMs = options.fallbackPollIntervalMs ?? FALLBACK_POLL_INTERVAL_MS;
        this.ownsWatchHub = !options.watchHub;
        this.watchHub = options.watchHub ?? new WatchHub({ logger });
        this.readConfigSource = options.readConfigSource ?? readBoundedConfigSource;
        this.writeConfigSource = options.writeConfigSource ?? atomicWrite;
        this.configDirectory = join(userDataPath, 'config');
        this.settingsPath = join(this.configDirectory, 'settings.jsonc');
        this.keybindingsPath = join(this.configDirectory, 'keybindings.jsonc');
        this.themePath = join(this.configDirectory, 'theme.json');
    }

    private async loadOrCreate(kind: ConfigKind): Promise<void> {
        this.assertOpen();
        const path = this.pathFor(kind);
        let source: string;
        try {
            source = await this.readConfigSource(path);
            this.assertOpen();
            this.rejectedSourceRevisions.delete(path);
        } catch (error) {
            this.assertOpen();
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                source = this.sourceFor(kind);
                await this.writeConfigSource(path, source);
                this.assertOpen();
                if (kind === 'settings') this.createdSettingsThisRun = true;
                if (kind === 'theme' && this.createdSettingsThisRun)
                    await this.followSystemAppearanceByDefault();
                return;
            }
            this.rememberRejectedSource(path, error);
            this.recordConfigurationError(kind, error);
            return;
        }
        try {
            const prepared = this.prepare(kind, source, kind !== 'theme');
            if (prepared.source !== source) {
                try {
                    await this.writeConfigSource(path, prepared.source);
                    this.assertOpen();
                } catch (error) {
                    this.assertOpen();
                    /**
                     * A default migration is best-effort. A valid user configuration must remain active when its
                     * reconciled form cannot be persisted, instead of silently falling back to built-in defaults.
                     */
                    const original = this.prepare(kind, source);
                    original.apply();
                    this.observedSources.set(path, source);
                    this.recordConfigurationError(kind, error);
                    return;
                }
            }
            prepared.apply();
            this.observedSources.set(path, prepared.source);
            this.errors.delete(kind);
        } catch (error) {
            this.assertOpen();
            this.recordConfigurationError(kind, error);
        }
    }

    /**
     * A profile whose `settings.jsonc` and `theme.json` were both missing is a first launch that has never chosen a
     * theme, so it follows the system appearance until the user picks one. The file written next to it (Dracula) cannot
     * tell that user from one who saved Dracula by hand, which is why the flag lives in Settings and is set exactly
     * here, at creation. An existing `theme.json` is always an explicit choice and keeps the flag at its `false`
     * default; an existing `settings.jsonc` is never rewritten just to add it.
     */
    private async followSystemAppearanceByDefault(): Promise<void> {
        const source = applyEdits(
            this.settingsSource,
            modify(this.settingsSource, ['workbench.theme.followSystem'], true, {
                formattingOptions: JSONC_FORMATTING_OPTIONS,
            }),
        );
        const prepared = this.prepare('settings', source);
        await this.writeConfigSource(this.settingsPath, prepared.source);
        this.assertOpen();
        // Initialization runs before any Client or Settings subscriber exists, so this is applied without an event.
        prepared.apply();
        this.observedSources.set(this.settingsPath, prepared.source);
    }

    private assertOpen(): void {
        if (this.closed) throw new CaxriError('UNAVAILABLE', 'Configuration service is closed');
    }

    private isClosed(): boolean {
        return this.closed;
    }

    private recordConfigurationError(kind: ConfigKind, error: unknown): void {
        const fileName = basename(this.pathFor(kind));
        const detail = errorMessage(error, 'Configuration load failed');
        const message = detail.startsWith(`${fileName}:`) ? detail : `${fileName}: ${detail}`;
        this.errors.set(kind, message);
        this.logger?.write('warn', logEventCatalog.configuration.loadFailed, {
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

    private prepare(
        kind: ConfigKind,
        source: string,
        shouldReconcileDefaults = false,
    ): PreparedConfig {
        const path = this.pathFor(kind);
        try {
            configSourceSchema.parse(source);
            if (kind === 'settings') {
                const prepared = prepareSettingsSource(source, shouldReconcileDefaults);
                return {
                    source: prepared.source,
                    apply: () => {
                        this.settings = prepared.value;
                        this.settingsSource = prepared.source;
                    },
                };
            }
            if (kind === 'keybindings') {
                const prepared = prepareKeybindingsSource(source, shouldReconcileDefaults);
                return {
                    source: prepared.source,
                    apply: () => {
                        this.keybindings = prepared.value;
                        this.keybindingsSource = prepared.source;
                    },
                };
            }
            const prepared = prepareThemeSource(source);
            return {
                source: prepared.source,
                apply: () => {
                    this.theme = prepared.value;
                    this.themeSource = prepared.source;
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
                    this.logger?.write('error', logEventCatalog.configuration.watchChangeFailed, {
                        fields: { path, error: errorMessage(error, 'unknown') },
                    }),
                );
            }, WATCH_SETTLE_DELAY_MS),
        );
    }

    private async onExternalChange(path: string): Promise<void> {
        if (this.isClosed()) return;
        const kind = this.kindForPath(path);
        if (!kind) return;
        try {
            const source = await this.readConfigSource(path);
            if (this.isClosed()) return;
            this.rejectedSourceRevisions.delete(path);
            if (source === this.observedSources.get(path)) return;
            this.observedSources.set(path, source);
            const prepared = this.prepare(kind, source);
            if (prepared.source !== source) {
                await this.writeConfigSource(path, prepared.source);
                if (this.isClosed()) return;
                this.observedSources.set(path, prepared.source);
            }
            if (prepared.source === this.sourceFor(kind)) return;
            prepared.apply();
            this.errors.delete(kind);
            this.emitChange(kind, prepared.source);
            if (kind === 'settings') this.notifySettings();
        } catch (error) {
            if (this.isClosed()) return;
            if (this.rememberRejectedSource(path, error)) return;
            this.recordConfigurationError(kind, error);
        }
    }

    private emitWatcherError(error: Error): void {
        const message = `Configuration watcher failed: ${error.message}`;
        this.logger?.write('warn', logEventCatalog.configuration.watcherError, {
            fields: { error: error.message },
        });
        for (const kind of ['settings', 'keybindings', 'theme'] satisfies ConfigKind[]) {
            this.emitChange(kind, this.sourceFor(kind), message);
        }
    }

    private async update(kind: ConfigKind, source: string): Promise<void> {
        this.assertOpen();
        const prepared = this.prepare(kind, source);
        const path = this.pathFor(kind);
        await this.writeConfigSource(path, prepared.source);
        this.assertOpen();
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
        // Isolates each settings subscriber so one throwing listener cannot stop the rest from observing this
        // settings change; only the failure reason is logged, never the settings payload.
        notifyListeners(this.settingsListeners, this.settings, (error) =>
            this.logger?.write('warn', logEventCatalog.configuration.settingsListenerFailed, {
                fields: { error: errorMessage(error, 'unknown') },
            }),
        );
    }

    /**
     * Serializes read-modify-write Settings operations so concurrent trust prompts cannot lose rules.
     */
    private mutateSettings<T>(operation: () => Promise<T>): Promise<T> {
        const previousTail = this.settingsMutationTail;
        const result = (async () => {
            this.assertOpen();
            await previousTail;
            this.assertOpen();
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
                    this.logger?.write('error', logEventCatalog.configuration.pollChangeFailed, {
                        fields: { path, error: errorMessage(error, 'unknown') },
                    });
                }
            }),
        );
    }

    /**
     * Appends one already-normalized rule to a bounded allowlist setting, preserving the user's JSONC comments.
     */
    private appendTrustedRule(options: {
        key: 'security.trustedDomains' | 'security.trustedFolders';
        rule: string | undefined;
        maximum: number;
        label: string;
        invalidMessage: string;
    }): Promise<void> {
        return this.mutateSettings(async () => {
            const { key, rule, maximum, label } = options;
            if (!rule) throw new CaxriError('VALIDATION', options.invalidMessage);
            const current = this.settings[key];
            if (current.includes(rule)) return;
            if (current.length >= maximum)
                throw new CaxriError('CAPACITY', `${label} supports at most ${maximum} rules`);
            const source = applyEdits(
                this.settingsSource,
                modify(this.settingsSource, [key], [...current, rule], {
                    formattingOptions: JSONC_FORMATTING_OPTIONS,
                }),
            );
            await this.update('settings', source);
        });
    }

    async initialize(): Promise<void> {
        this.assertOpen();
        await mkdir(dirname(this.settingsPath), { recursive: true });
        this.assertOpen();
        await this.loadOrCreate('settings');
        await this.loadOrCreate('keybindings');
        await this.loadOrCreate('theme');
        const watchedDirectory = await realpath(this.configDirectory);
        this.assertOpen();
        const startedAt = performance.now();
        const watchHandle = await this.watchHub.register({
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
        if (this.closed) {
            await watchHandle.dispose();
            this.assertOpen();
        }
        this.watchHandle = watchHandle;
        this.logger?.write('info', logEventCatalog.configuration.watcherReady, {
            durationMs: performance.now() - startedAt,
            fields: { backend: watchHandle.mode },
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

    /**
     * Owner-only import preserves unrelated JSONC; Agent settings patches cannot reach private instructions.
     */
    importDelegationSettings(settings: AgentDelegationSettings, isDryRun: boolean) {
        return this.mutateSettings(async () => {
            const value = agentDelegationSettingsSchema.parse(settings);
            const isChanged =
                JSON.stringify(this.settings['agents.delegation']) !== JSON.stringify(value);
            const source = applyEdits(
                this.settingsSource,
                modify(this.settingsSource, ['agents.delegation'], value, {
                    formattingOptions: JSONC_FORMATTING_OPTIONS,
                }),
            );
            this.prepare('settings', source);
            if (!isDryRun && isChanged) await this.update('settings', source);
            return {
                dryRun: isDryRun,
                changed: isChanged,
                presetNames: value.presets.map(({ name }) => name),
                maxDepth: value.maxDepth,
            };
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
        return this.mutateSettings(() => {
            this.prepare('settings', source);
            return this.update('settings', preserveRecentAgentActions(source, this.settings));
        });
    }

    /**
     * Persists only a provider-scoped invocation identity through the serialized Settings mutation path. The caller
     * derives the provider from the Terminal record, so Renderer input cannot select another provider's history.
     */
    recordRecentAgentAction(
        provider: AgentProvider,
        invocation: string,
    ): Promise<AgentActionRecentSettings> {
        return this.mutateSettings(async () => {
            const current = this.settings['agents.providers'][provider].actions;
            const next = pushRecentAgentAction(current, invocation);
            if (
                next.recent.invocations.length === current.recent.invocations.length &&
                next.recent.invocations.every(
                    (candidate, index) => candidate === current.recent.invocations[index],
                )
            )
                return current.recent;
            const source = applyEdits(
                this.settingsSource,
                modify(
                    this.settingsSource,
                    ['agents.providers', provider, 'actions', 'recent'],
                    next.recent,
                    { formattingOptions: JSONC_FORMATTING_OPTIONS },
                ),
            );
            await this.update('settings', source);
            return this.settings['agents.providers'][provider].actions.recent;
        });
    }

    trustDomain(input: string): Promise<void> {
        return this.appendTrustedRule({
            key: 'security.trustedDomains',
            rule: normalizeTrustedDomainRule(input),
            maximum: MAX_TRUSTED_DOMAINS,
            label: 'Trusted Domains',
            invalidMessage: 'Invalid trusted domain',
        });
    }

    trustFolder(input: string): Promise<void> {
        return this.appendTrustedRule({
            key: 'security.trustedFolders',
            rule: normalizeTrustedFolderRule(input),
            maximum: MAX_TRUSTED_FOLDERS,
            label: 'Trusted Folders',
            invalidMessage: 'Invalid trusted folder',
        });
    }

    updateKeybindings(source: string): Promise<void> {
        return this.update('keybindings', source);
    }

    updateTheme(source: string): Promise<void> {
        return this.update('theme', source);
    }

    async importTheme(
        path: string,
    ): Promise<{ value: ThemeTokens; warnings: ThemeImportWarning[] }> {
        this.assertOpen();
        const imported = await importTheme(path, this.theme);
        await this.update('theme', serializeTheme(imported));
        return { value: this.theme, warnings: imported.warnings };
    }

    close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        for (const timer of this.watchTimers.values()) clearTimeout(timer);
        this.watchTimers.clear();
        this.settingsListeners.clear();
        const handle = this.watchHandle;
        this.watchHandle = undefined;
        this.closePromise = (async () => {
            await handle?.dispose();
            if (this.ownsWatchHub) await this.watchHub.close();
        })();
        return this.closePromise;
    }
}

import type { AppSettings } from '@caxri/protocol';
import { redactArgv, redactCommandLine } from '@caxri/utils';

type AgentProviderSettings = AppSettings['agents.providers'][keyof AppSettings['agents.providers']];
type AgentActionsSettings = AgentProviderSettings['actions'];
type AgentActionOverride = AgentActionsSettings['items'][string];
type DelegationSettings = AppSettings['agents.delegation'];
type DelegationPreset = DelegationSettings['presets'][number];
type DelegationCaller = NonNullable<
    DelegationSettings['callers'][keyof DelegationSettings['callers']]
>;
type DelegationBinding = NonNullable<DelegationCaller['presets']>[string];

/**
 * Names every field of `T`, optional ones included. A projected object literal checked against it fails typecheck when
 * the source shape gains a field, so a new nested setting cannot reach the export before someone classifies it. Extra
 * keys stay allowed for derived summaries such as `patternCount`.
 */
type Projection<T> = { [Key in keyof T]-?: unknown } & Record<string, unknown>;

/**
 * One export rule per top-level settings key. The mapped type makes a new `AppSettings` key a type error here, and the
 * projection reads only these keys, so an unclassified setting is dropped from the export rather than copied verbatim.
 */
type SettingsProjection = {
    readonly [Key in keyof AppSettings]: (value: AppSettings[Key]) => unknown;
};

/**
 * Presence and size of user-authored text; the text itself never leaves the machine.
 */
interface RedactedText {
    length: number;
    redacted: true;
}

function redactText(value: string | undefined): RedactedText | undefined {
    return value === undefined ? undefined : { redacted: true, length: value.length };
}

/**
 * Reserved for values support can read without learning user content: enums, booleans, numbers, font names, glob and
 * check rules, origins, and filesystem paths (the export's generic redaction pass normalizes home directories). Never
 * use it for free text written for an Agent or for a command line.
 */
const exportAsIs = <Value>(value: Value): Value => value;

function projectActions(actions: AgentActionsSettings) {
    return {
        items: Object.fromEntries(
            Object.entries(actions.items).map(([invocation, item]) => [
                invocation,
                {
                    enabled: item.enabled,
                    description: redactText(item.description),
                    argumentHint: redactText(item.argumentHint),
                } satisfies Projection<AgentActionOverride>,
            ]),
        ),
        // Bounded `/name` or `$name` identities only; the schema keeps arguments and Terminal input out of it.
        recent: actions.recent,
    } satisfies Projection<AgentActionsSettings>;
}

/**
 * Launch arguments are argv elements, which carry no key for the generic redaction pass to recognize, so the value
 * after `--api-key` needs the argv rule. Recovery patterns are user-authored output text and leave only their count.
 */
function projectAgentProviders(providers: AppSettings['agents.providers']) {
    return Object.fromEntries(
        Object.entries(providers).map(([provider, settings]) => [
            provider,
            {
                actions: projectActions(settings.actions),
                hooks: { enabled: settings.hooks.enabled } satisfies Projection<
                    AgentProviderSettings['hooks']
                >,
                launch: {
                    executable: settings.launch.executable,
                    args: redactArgv(settings.launch.args),
                } satisfies Projection<AgentProviderSettings['launch']>,
                messaging: { enabled: settings.messaging.enabled } satisfies Projection<
                    AgentProviderSettings['messaging']
                >,
                recovery: {
                    enabled: settings.recovery.enabled,
                    // Deliberately omitted (JSON drops `undefined`); only `patternCount` below is exported.
                    patterns: undefined,
                    patternCount: settings.recovery.patterns.length,
                    settleDelayMs: settings.recovery.settleDelayMs,
                    continueDelayMs: settings.recovery.continueDelayMs,
                } satisfies Projection<AgentProviderSettings['recovery']>,
            } satisfies Projection<AgentProviderSettings>,
        ]),
    );
}

function projectDelegationBinding(binding: DelegationBinding) {
    return {
        provider: binding.provider,
        model: binding.model,
        effort: binding.effort,
        useWhen: redactText(binding.useWhen),
        dontUseWhen: redactText(binding.dontUseWhen),
    } satisfies Projection<DelegationBinding>;
}

/**
 * Preset instructions, caller `prepend`/`append`, and `useWhen`/`dontUseWhen` are private task content written for an
 * Agent (see `docs/agent-delegation.md`). Support keeps the routing shape (names, provider, model, effort, depth,
 * exclusions) and only learns whether each text field is set and how long it is.
 */
function projectDelegation(delegation: DelegationSettings) {
    return {
        maxDepth: delegation.maxDepth,
        presets: delegation.presets.map(
            (preset) =>
                ({
                    name: preset.name,
                    provider: preset.provider,
                    model: preset.model,
                    effort: preset.effort,
                    useWhen: redactText(preset.useWhen),
                    dontUseWhen: redactText(preset.dontUseWhen),
                    instructions: redactText(preset.instructions),
                }) satisfies Projection<DelegationPreset>,
        ),
        callers: Object.fromEntries(
            Object.entries(delegation.callers).map(([provider, caller]) => [
                provider,
                {
                    presets:
                        caller.presets &&
                        Object.fromEntries(
                            Object.entries(caller.presets).map(([name, binding]) => [
                                name,
                                projectDelegationBinding(binding),
                            ]),
                        ),
                    exclude: caller.exclude,
                    prepend: redactText(caller.prepend),
                    append: redactText(caller.append),
                } satisfies Projection<DelegationCaller>,
            ]),
        ),
    } satisfies Projection<DelegationSettings>;
}

const settingsProjection: SettingsProjection = {
    'notifications.worktreeFallback': exportAsIs,
    'notifications.agentRecovery': exportAsIs,
    'environmentMonitor.publicIpChanges': exportAsIs,
    'environmentMonitor.proxyProtection': exportAsIs,
    'environmentMonitor.locationChanges': exportAsIs,
    'environmentMonitor.timeZoneMismatch': exportAsIs,
    'environmentMonitor.checkUnavailable': exportAsIs,
    'session.defaultAgent': exportAsIs,
    'session.openAgentsInChat': exportAsIs,
    'agentChat.idleCompaction.enabled': exportAsIs,
    'agentChat.autoContinueAtUsageLimit': exportAsIs,
    'agentChat.longPasteThreshold': exportAsIs,
    'agentChat.workingIndicator': exportAsIs,
    'agentChat.animatedToolIcons': exportAsIs,
    'agentChat.statusShimmer': exportAsIs,
    'workbench.newWorktreeBehavior': exportAsIs,
    'workbench.confirmWorktreeAuthorization': exportAsIs,
    'primarySidebar.autoCollapseProjects': exportAsIs,
    'primarySidebar.showSubagents': exportAsIs,
    'primarySidebar.translucent': exportAsIs,
    'statusBar.usage.showFiveHourLimit': exportAsIs,
    'window.zoomLevel': exportAsIs,
    'workbench.fontFamily': exportAsIs,
    'workbench.language': exportAsIs,
    /**
     * A command line (`code --profile work`), so credential flags go through the same rule as launch arguments.
     */
    'workbench.externalEditor': (value) => (value === null ? null : redactCommandLine(value)),
    'updates.skippedVersion': exportAsIs,
    'agents.providers': projectAgentProviders,
    'agents.delegation': projectDelegation,
    /**
     * Patterns are command lines the user typed, so credential flags go through the same rule as launch arguments.
     */
    'agents.longRunningShellCommands': (patterns) =>
        patterns.map((pattern) => redactCommandLine(pattern)),
    /**
     * Free text written for an Agent: support learns only whether it is Caxri's preset, never the user's wording.
     */
    'agents.sessionInstructions': (value) => (value === null ? 'default' : redactText(value)),
    'agents.suggestLifecycleHooks': exportAsIs,
    'agents.notifications.enabled': exportAsIs,
    'agents.notifications.completionThresholdSeconds': exportAsIs,
    'git.fetchGitHubAvatars': exportAsIs,
    'projectStatus.ignoredChecks': exportAsIs,
    'projectStatus.notifyAgentOnMerge': exportAsIs,
    'projectStatus.autoArchiveOnPullRequestSettled': exportAsIs,
    'projectStatus.notifications.enabled': exportAsIs,
    'security.trustedDomains': exportAsIs,
    'security.trustedFolders': exportAsIs,
    'terminal.defaultWorkingDirectory': exportAsIs,
    'terminal.wordSeparators': exportAsIs,
    'terminal.referenceLinks': exportAsIs,
    'terminal.fontFamily': exportAsIs,
    'terminal.fontSize': exportAsIs,
    'files.autoSave': exportAsIs,
    'editor.fontFamily': exportAsIs,
    'editor.fontSize': exportAsIs,
    'editor.wordWrap': exportAsIs,
    'editor.wordSeparators': exportAsIs,
    'editor.autoClosingDelete': exportAsIs,
    'editor.linkedEditing': exportAsIs,
    'editor.stickyScroll.enabled': exportAsIs,
    'editor.stickyTabStops': exportAsIs,
    'editor.bracketPairColorization.enabled': exportAsIs,
    'editor.guides.bracketPairs': exportAsIs,
    'editor.renderWhitespace': exportAsIs,
    'editor.cursorBlinking': exportAsIs,
    'editor.cursorSmoothCaretAnimation': exportAsIs,
    'editor.smoothScrolling': exportAsIs,
    'editor.dragAndDrop': exportAsIs,
    'editor.minimap.enabled': exportAsIs,
    'editor.unfoldOnClickAfterEndOfLine': exportAsIs,
    'editor.foldOnOpenLineThreshold': exportAsIs,
    'terminal.scrollback': exportAsIs,
    'terminal.longPasteThreshold': exportAsIs,
    'terminal.copyOnSelect': exportAsIs,
    'terminal.gpuAcceleration': exportAsIs,
    'terminal.suspendUntouchedAgents': exportAsIs,
    'terminal.idleSuspension.enabled': exportAsIs,
    'terminal.idleSuspension.afterMinutes': exportAsIs,
    'terminal.osc52ClipboardWrite': exportAsIs,
    'files.exclude': exportAsIs,
    'git.diffExclude': exportAsIs,
    'files.maxFileBytes': exportAsIs,
};

function projectSetting<Key extends keyof AppSettings>(settings: AppSettings, key: Key): unknown {
    return settingsProjection[key](settings[key]);
}

/**
 * Builds the support view of Settings from the explicit per-key table above instead of spreading `AppSettings`, so
 * Agent prompt text and argv credentials stay local and a future key is excluded until it declares a rule.
 */
export function diagnosticSettings(settings: AppSettings): Record<string, unknown> {
    return Object.fromEntries(
        (Object.keys(settingsProjection) as Array<keyof AppSettings>).map((key) => [
            key,
            projectSetting(settings, key),
        ]),
    );
}

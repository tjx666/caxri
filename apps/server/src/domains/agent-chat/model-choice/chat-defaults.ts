import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type {
    AgentChatDefaults,
    AgentChatDefaultsProvider,
    AgentChatModel,
    AgentLaunchSettings,
} from '@caxri/protocol';
import { agentChatModelSchema, CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, readE2EAgentPolicy } from '@caxri/system';

import type { AgentEnvironment } from '../../agents';
import { agentCommandEnvironment, resolveCodexHome } from '../../agents';
import type { CaxriDatabase } from '../../db';
import type { TerminalManagerOptions } from '../../terminal';
import { resolveTerminalExecutable } from '../../terminal';
import {
    claudeDefaultOverrides,
    claudeLaunchDefaults,
    claudeSettingsPath,
    readClaudeFileDefaults,
    writeClaudeFileDefaults,
} from './claude-defaults';
import type { CodexDefaultsContext, CodexDefaultsReading } from './codex-defaults';
import {
    codexDefaultOverrides,
    codexLaunchDefaults,
    readCodexDefaults,
    writeCodexDefaults,
} from './codex-defaults';
import type { AgentChatDefaultChoice } from './stored-choice';

/**
 * A global default change from Settings: a value replaces the key, `null` removes it so the Agent's built-in default
 * applies again, and an absent key is left as it is.
 */
export interface AgentChatDefaultsChange {
    model?: string | null;
    effort?: string | null;
    ultracode?: boolean | null;
}

export interface AgentChatDefaultsOptions {
    database: Pick<CaxriDatabase, 'getAppState' | 'setAppState'>;
    logger: StructuredLogger;
    agentEnvironment: AgentEnvironment;
    launchSettings(provider: AgentChatDefaultsProvider): AgentLaunchSettings;
    resolveExecutable?: TerminalManagerOptions['resolveExecutable'];
    /**
     * The environment a Chat's provider process gets, where `ANTHROPIC_MODEL` and `CLAUDE_CODE_EFFORT_LEVEL` override
     * the settings file. Overridable so tests need no login shell.
     */
    environment?: () => Promise<NodeJS.ProcessEnv>;
    /**
     * Overrides the one-shot `codex app-server` reads and writes, so tests need no Codex CLI.
     */
    codex?: {
        read: (context: CodexDefaultsContext) => Promise<CodexDefaultsReading>;
        write: (
            context: CodexDefaultsContext,
            change: Pick<AgentChatDefaultsChange, 'effort' | 'model'>,
        ) => Promise<void>;
    };
}

interface ProviderReading {
    file: AgentChatDefaultChoice;
    launch: AgentChatDefaultChoice;
    environment: NodeJS.ProcessEnv;
    models: AgentChatModel[];
    path: string;
    accountDefaultModel?: string;
}

/**
 * The global model, effort, and ultracode default of each Agent, which a new Chat and a Chat reset with the picker's ↺
 * start from. The Agent's own config file is the source of truth (Claude Code's `settings.json`, Codex's
 * `config.toml`), so a default set in the Agent's own TUI and one set in Caxri's Settings are the same value; Caxri
 * keeps no copy. The launch arguments in Settings (and, for Claude Code, its environment variables) outrank the file,
 * and are reported as overrides so Settings can say why a saved default does not apply.
 *
 * Claude Code has no model listing outside a running Chat, so the models a Chat listed last are cached in app state for
 * Settings; Codex lists them through the same one-shot app-server that reads its config.
 */
export class AgentChatDefaultsService {
    constructor(private readonly options: AgentChatDefaultsOptions) {}

    private async readProvider(provider: AgentChatDefaultsProvider): Promise<ProviderReading> {
        const { args } = this.options.launchSettings(provider);
        const environment = await (this.options.environment?.() ??
            agentCommandEnvironment(this.options.agentEnvironment));
        if (provider === 'claude') {
            const path = claudeSettingsPath(this.options.agentEnvironment);
            const models = this.cachedModels('claude');
            return {
                file: await readClaudeFileDefaults(path, models),
                launch: claudeLaunchDefaults(args),
                environment,
                models,
                path,
            };
        }
        const path = join(resolveCodexHome(this.options.agentEnvironment), 'config.toml');
        const launch = codexLaunchDefaults(args);
        /**
         * E2E never spawns a host provider, and the one-shot app-server is one; the file reads as empty there.
         */
        if (readE2EAgentPolicy() && !this.options.codex)
            return { file: {}, launch, environment, models: this.cachedModels('codex'), path };
        const reading = await (this.options.codex?.read ?? readCodexDefaults)(
            await this.codexContext(),
        );
        this.observeModels('codex', reading.models);
        return {
            file: reading.file,
            launch,
            environment,
            models: reading.models.length > 0 ? reading.models : this.cachedModels('codex'),
            path,
            ...(reading.accountDefaultModel && {
                accountDefaultModel: reading.accountDefaultModel,
            }),
        };
    }

    private async codexContext(): Promise<CodexDefaultsContext> {
        const launch = this.options.launchSettings('codex');
        return {
            executable: await resolveTerminalExecutable(
                'codex',
                launch,
                this.options.resolveExecutable,
            ),
            environment: this.options.agentEnvironment,
        };
    }

    private cachedModels(provider: AgentChatDefaultsProvider): AgentChatModel[] {
        return this.options.database.getAppState('agentChatModels')?.[provider] ?? [];
    }

    async read(provider: AgentChatDefaultsProvider): Promise<AgentChatDefaults> {
        const reading = await this.readProvider(provider);
        const overrides =
            provider === 'claude'
                ? claudeDefaultOverrides(reading.launch, reading.environment)
                : codexDefaultOverrides(reading.launch);
        const builtInModel =
            provider === 'claude'
                ? reading.models.find((model) => model.id === 'default')?.id
                : reading.accountDefaultModel;
        return {
            provider,
            ...reading.file,
            overrides,
            models: reading.models,
            ...(builtInModel && { builtInModel }),
            file: homeRelative(reading.path, this.options.agentEnvironment.homeDirectory),
        };
    }

    async write(
        provider: AgentChatDefaultsProvider,
        change: AgentChatDefaultsChange,
    ): Promise<AgentChatDefaults> {
        const keys = Object.entries(change)
            .filter(([, value]) => value !== undefined)
            .map(([key]) => key)
            .join(',');
        try {
            if (provider === 'codex' && readE2EAgentPolicy() && !this.options.codex)
                throw new CaxriError('UNAVAILABLE', 'Codex defaults are unavailable in E2E');
            if (provider === 'claude')
                await writeClaudeFileDefaults(
                    claudeSettingsPath(this.options.agentEnvironment),
                    this.cachedModels('claude'),
                    change,
                );
            else
                await (this.options.codex?.write ?? writeCodexDefaults)(await this.codexContext(), {
                    model: change.model,
                    effort: change.effort,
                });
        } catch (error) {
            this.options.logger.write('warn', logEventCatalog.agentChat.defaultsWritten, {
                fields: { provider, outcome: 'failed', keys },
            });
            throw error;
        }
        this.options.logger.write('info', logEventCatalog.agentChat.defaultsWritten, {
            fields: { provider, outcome: 'written', keys },
        });
        return this.read(provider);
    }

    /**
     * The default a Chat reset goes back to, each key taken from the highest layer that names it: Claude Code's
     * environment variables, then the launch arguments, then the config file. A Codex Chat with no configured model
     * starts on the account's default model, so that is its default too.
     */
    async resolve(provider: AgentChatDefaultsProvider): Promise<AgentChatDefaultChoice> {
        const { file, launch, environment, accountDefaultModel } =
            await this.readProvider(provider);
        const choice: AgentChatDefaultChoice = { ...file, ...launch };
        if (provider === 'claude') {
            if (!launch.model && environment.ANTHROPIC_MODEL)
                choice.model = environment.ANTHROPIC_MODEL;
            if (environment.CLAUDE_CODE_EFFORT_LEVEL)
                choice.effort = environment.CLAUDE_CODE_EFFORT_LEVEL;
        } else if (accountDefaultModel && !choice.model) choice.model = accountDefaultModel;
        return choice;
    }

    /**
     * Remembers the models a Chat listed, so Settings can offer them before the next Chat of that Agent starts. A
     * listing equal to the cached one writes nothing.
     */
    observeModels(provider: string, models: readonly AgentChatModel[] | undefined): void {
        if ((provider !== 'claude' && provider !== 'codex') || !models?.length) return;
        const cached = this.options.database.getAppState('agentChatModels') ?? {};
        // Parsed like the stored copy, so a listing equal to it compares equal whatever its key order.
        const next = agentChatModelSchema.array().parse(models.slice(0, 50));
        if (isDeepStrictEqual(cached[provider], next)) return;
        this.options.database.setAppState('agentChatModels', { ...cached, [provider]: next });
    }
}

/**
 * A path under the home directory as `~/...`, the way Settings shows a config file.
 */
function homeRelative(path: string, home: string): string {
    return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

import type { AgentChatDefaultOverride, AgentChatModel } from '@caxri/protocol';
import { expandLaunchArguments } from '@caxri/utils';

import type { AgentEnvironment } from '../../agents';
import { callCodexAppServer } from '../../agents';
import { isRecord, stringField } from '../chat-items';
import { codexChatModels } from '../providers/codex/models';
import type { AgentChatDefaultChoice } from './stored-choice';

/**
 * `model/list` names every model with its efforts and descriptions, which outgrows the rename call's output bound.
 */
const CODEX_DEFAULTS_OUTPUT_BYTES = 1024 * 1024;

export interface CodexDefaultsContext {
    executable: string;
    environment: AgentEnvironment;
}

export interface CodexDefaultsReading {
    file: AgentChatDefaultChoice;
    models: AgentChatModel[];
    /**
     * The model `model/list` marks as the account's default, which a Chat uses when `config.toml` names none.
     */
    accountDefaultModel?: string;
}

/**
 * Reads `config.toml`'s `model` and `model_reasoning_effort` and the account's models through a one-shot `codex
 * app-server`, so Codex itself resolves `CODEX_HOME`, profiles, and its own TOML. It runs in the home directory without
 * the launch arguments, so neither a Project's `.codex/config.toml` nor a `-c` override colors the user's own default.
 */
export async function readCodexDefaults(
    context: CodexDefaultsContext,
): Promise<CodexDefaultsReading> {
    const [config, list] = await callCodexAppServer(
        {
            executable: context.executable,
            cwd: context.environment.homeDirectory,
            environment: context.environment,
            purpose: 'default model read',
            maximumOutputBytes: CODEX_DEFAULTS_OUTPUT_BYTES,
        },
        [
            { method: 'config/read', params: { cwd: context.environment.homeDirectory } },
            { method: 'model/list', params: { limit: 50 } },
        ],
    );
    const values = isRecord(config) && isRecord(config.config) ? config.config : {};
    const model = stringField(values.model);
    const effort = stringField(values.model_reasoning_effort);
    const entries: unknown[] = isRecord(list) && Array.isArray(list.data) ? list.data : [];
    const accountDefault = entries.find((entry) => isRecord(entry) && entry.isDefault === true);
    const accountDefaultModel = isRecord(accountDefault)
        ? (stringField(accountDefault.model) ?? stringField(accountDefault.id))
        : undefined;
    return {
        file: { ...(model && { model }), ...(effort && { effort }) },
        models: codexChatModels(list),
        ...(accountDefaultModel && { accountDefaultModel }),
    };
}

/**
 * Writes the default to `config.toml` through `config/batchWrite`, the writer Codex's own TUI uses, so comments and
 * formatting survive. `null` sends a null value, which removes the key.
 */
export async function writeCodexDefaults(
    context: CodexDefaultsContext,
    change: { model?: string | null; effort?: string | null },
): Promise<void> {
    const edits = (
        [
            ['model', change.model],
            ['model_reasoning_effort', change.effort],
        ] as const
    ).flatMap(([keyPath, value]) =>
        value === undefined ? [] : [{ keyPath, value, mergeStrategy: 'replace' }],
    );
    if (edits.length === 0) return;
    await callCodexAppServer(
        {
            executable: context.executable,
            cwd: context.environment.homeDirectory,
            environment: context.environment,
            purpose: 'default model write',
        },
        [{ method: 'config/batchWrite', params: { edits } }],
    );
}

/**
 * The model and effort Codex's launch arguments name: `-m`/`--model`, and `-c`/`--config` overrides of `model` and
 * `model_reasoning_effort`. A `--profile` is not resolved; its keys show up once a Chat reports them.
 */
export function codexLaunchDefaults(arguments_: readonly string[]): AgentChatDefaultChoice {
    const expanded = expandLaunchArguments([...arguments_]);
    const result: AgentChatDefaultChoice = {};
    for (let index = 0; index < expanded.length; index += 1) {
        const argument = expanded[index];
        const equals = argument.indexOf('=');
        const name = argument.startsWith('--') && equals > 0 ? argument.slice(0, equals) : argument;
        if (!['-m', '--model', '-c', '--config'].includes(name)) continue;
        const value = name === argument ? expanded.at(++index) : argument.slice(equals + 1);
        if (!value) continue;
        if (name === '-m' || name === '--model') {
            result.model = value;
            continue;
        }
        const override = /^(model|model_reasoning_effort)\s*=(.*)$/u.exec(value.trim());
        const overrideValue = override?.[2]?.trim().replaceAll('"', '');
        if (!overrideValue) continue;
        if (override?.[1] === 'model') result.model = overrideValue;
        else result.effort = overrideValue;
    }
    return result;
}

export function codexDefaultOverrides(launch: AgentChatDefaultChoice): AgentChatDefaultOverride[] {
    return [
        ...(launch.model
            ? [{ key: 'model' as const, source: 'launchArgs' as const, value: launch.model }]
            : []),
        ...(launch.effort
            ? [{ key: 'effort' as const, source: 'launchArgs' as const, value: launch.effort }]
            : []),
    ];
}

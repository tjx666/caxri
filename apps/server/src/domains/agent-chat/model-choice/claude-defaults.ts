import { realpath } from 'node:fs/promises';
import { join } from 'node:path';

import type { AgentChatDefaultOverride, AgentChatModel } from '@caxri/protocol';
import { CaxriError, findAgentChatModel } from '@caxri/protocol';
import { atomicWriteFile, readBoundedRegularFileText } from '@caxri/system';
import { expandLaunchArguments } from '@caxri/utils';

import type { AgentEnvironment } from '../../agents';
import { resolveClaudeConfigDirectory } from '../../agents';
import type { AgentChatDefaultChoice } from './stored-choice';

const MAX_SETTINGS_BYTES = 1024 * 1024;

/**
 * The efforts Claude Code persists to a settings file. `max` is session-only: Claude Code never writes it, and a
 * settings file that names it fails Claude Code's own validation.
 */
const PERSISTED_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The user settings file Claude Code reads its own defaults from: `settings.json` in the config directory, which
 * follows `CLAUDE_CONFIG_DIR` the same way Claude Code does, so each account keeps its own default.
 */
export function claudeSettingsPath(environment: AgentEnvironment): string {
    return join(resolveClaudeConfigDirectory(environment), 'settings.json');
}

/**
 * Reads the settings file as an object. A missing file is an empty one; a file that is not a JSON object fails, so a
 * write never replaces a file the user broke by hand with only the keys Caxri knows.
 */
async function readSettings(path: string): Promise<Json> {
    let text: string;
    try {
        text = await readBoundedRegularFileText(path, MAX_SETTINGS_BYTES);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw error;
    }
    if (!text.trim()) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new CaxriError('VALIDATION', 'Claude Code settings.json is not valid JSON');
    }
    if (!isRecord(parsed))
        throw new CaxriError('VALIDATION', 'Claude Code settings.json is not a JSON object');
    return parsed;
}

/**
 * The key Claude Code saves a model's effort under (`modelSettings.<canonical model>`): the full model an alias such as
 * `opus` resolves to, as the model list reports it. Without the list the identifier itself is the best guess.
 */
function canonicalModel(
    models: readonly AgentChatModel[],
    model: string | undefined,
): string | undefined {
    const listed = findAgentChatModel(models, model ?? 'default');
    return listed?.resolvedId ?? model;
}

function stringField(value: unknown): string | undefined {
    return typeof value === 'string' && value ? value : undefined;
}

/**
 * The default the settings file names. The effort Claude Code's `/effort` saved for the default model wins over the
 * file-wide `effortLevel`, as it does in Claude Code.
 */
export async function readClaudeFileDefaults(
    path: string,
    models: readonly AgentChatModel[],
): Promise<AgentChatDefaultChoice> {
    const settings = await readSettings(path);
    const model = stringField(settings.model);
    const key = canonicalModel(models, model);
    const perModel =
        key && isRecord(settings.modelSettings) && isRecord(settings.modelSettings[key])
            ? stringField(settings.modelSettings[key].effortLevel)
            : undefined;
    const effort = perModel ?? stringField(settings.effortLevel);
    return {
        ...(model && { model }),
        ...(effort && { effort }),
        ...(typeof settings.ultracode === 'boolean' && { ultracode: settings.ultracode }),
    };
}

/**
 * Merges a default change into the settings file and writes it back atomically, leaving every other key as it was. A
 * symlinked settings file (a dotfiles checkout) is written through to its target instead of being replaced by a regular
 * file. `null` removes a key; ultracode off is removed rather than written, since off is Claude Code's own default. An
 * effort is written file-wide and, when `/effort` already saved one for the default model, there too, so the per-model
 * value cannot shadow the new default.
 */
export async function writeClaudeFileDefaults(
    path: string,
    models: readonly AgentChatModel[],
    change: { model?: string | null; effort?: string | null; ultracode?: boolean | null },
): Promise<void> {
    if (typeof change.effort === 'string' && !PERSISTED_EFFORTS.has(change.effort))
        throw new CaxriError(
            'VALIDATION',
            `Claude Code cannot save ${change.effort} as its default effort`,
        );
    const settings = await readSettings(path);
    if (change.model === null) delete settings.model;
    else if (change.model !== undefined) settings.model = change.model;
    if (change.effort !== undefined) {
        const key = canonicalModel(models, stringField(settings.model));
        const perModel =
            key && isRecord(settings.modelSettings) && isRecord(settings.modelSettings[key])
                ? settings.modelSettings[key]
                : undefined;
        if (change.effort === null) {
            delete settings.effortLevel;
            if (perModel) delete perModel.effortLevel;
        } else {
            settings.effortLevel = change.effort;
            if (perModel && 'effortLevel' in perModel) perModel.effortLevel = change.effort;
        }
    }
    if (change.ultracode === true) settings.ultracode = true;
    else if (change.ultracode !== undefined) delete settings.ultracode;
    let target = path;
    try {
        target = await realpath(path);
    } catch {
        // A missing file is created at the configured path.
    }
    await atomicWriteFile(target, `${JSON.stringify(settings, null, 2)}\n`, {
        durability: 'file',
    });
}

/**
 * The model, effort, and ultracode Claude Code's launch arguments name: `--model`, `--effort`, and an inline
 * `--settings` JSON object. A `--settings` file path is not read; Claude Code reads it, so a key it sets shows up as
 * the file's value once a Chat reports it.
 */
export function claudeLaunchDefaults(arguments_: readonly string[]): AgentChatDefaultChoice {
    const expanded = expandLaunchArguments([...arguments_]);
    const result: AgentChatDefaultChoice = {};
    for (let index = 0; index < expanded.length; index += 1) {
        const argument = expanded[index];
        const equals = argument.indexOf('=');
        const name = argument.startsWith('--') && equals > 0 ? argument.slice(0, equals) : argument;
        if (name !== '--model' && name !== '--effort' && name !== '--settings') continue;
        const value = name === argument ? expanded.at(++index) : argument.slice(equals + 1);
        if (!value) continue;
        if (name === '--model') result.model = value;
        else if (name === '--effort') result.effort = value;
        else Object.assign(result, inlineSettingsDefaults(value));
    }
    return result;
}

function inlineSettingsDefaults(value: string): AgentChatDefaultChoice {
    if (!value.trimStart().startsWith('{')) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return {};
    }
    if (!isRecord(parsed)) return {};
    const model = stringField(parsed.model);
    const effort = stringField(parsed.effortLevel);
    return {
        ...(model && { model }),
        ...(effort && { effort }),
        ...(typeof parsed.ultracode === 'boolean' && { ultracode: parsed.ultracode }),
    };
}

/**
 * The layers above the settings file, highest first per key: `CLAUDE_CODE_EFFORT_LEVEL` outranks every effort choice in
 * Claude Code, the launch arguments come next, and `ANTHROPIC_MODEL` names the model only when no `--model` does.
 */
export function claudeDefaultOverrides(
    launch: AgentChatDefaultChoice,
    environment: NodeJS.ProcessEnv,
): AgentChatDefaultOverride[] {
    const overrides: AgentChatDefaultOverride[] = [];
    if (launch.model) overrides.push({ key: 'model', source: 'launchArgs', value: launch.model });
    else if (environment.ANTHROPIC_MODEL)
        overrides.push({ key: 'model', source: 'environment', value: environment.ANTHROPIC_MODEL });
    if (environment.CLAUDE_CODE_EFFORT_LEVEL)
        overrides.push({
            key: 'effort',
            source: 'environment',
            value: environment.CLAUDE_CODE_EFFORT_LEVEL,
        });
    else if (launch.effort)
        overrides.push({ key: 'effort', source: 'launchArgs', value: launch.effort });
    if (launch.ultracode !== undefined)
        overrides.push({ key: 'ultracode', source: 'launchArgs', value: String(launch.ultracode) });
    return overrides;
}

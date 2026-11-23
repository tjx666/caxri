import type { AgentChatModel } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { readBoundedRegularFileText } from '@caxri/system';

import { atomicWriteUserConfig } from '../../atomic-file';
import { runExternalCommand } from '../../executables';
import type { AgentChatDefaultChoice } from './stored-choice';

/**
 * Antigravity's global model default is the `model` key of `~/.gemini/antigravity-cli/settings.json`, which `agy`'s own
 * `/model` writes and its TUI starts on. It names a model the way `agy models` lists it, with the thinking level in the
 * name (`Gemini 3.8 Flash (High)`), while a Chat sees a `model` config option (`gemini-3.8-flash`) and a separate
 * `thought_level`. `agy acp` ignores the key (measured on `agy` 1.5.14: a new session started on its own default
 * whatever the file named), so the Chat applies the default itself once it starts.
 */

const MAX_SETTINGS_BYTES = 1024 * 1024;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The thinking level as `agy` spells it inside a model name: `high` is `High`.
 */
function levelName(effort: string): string {
    return effort.charAt(0).toUpperCase() + effort.slice(1);
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
        throw new CaxriError('VALIDATION', 'Antigravity settings.json is not valid JSON');
    }
    if (!isRecord(parsed))
        throw new CaxriError('VALIDATION', 'Antigravity settings.json is not a JSON object');
    return parsed;
}

/**
 * The Chat model and effort an `agy` model name stands for, matched against the models a Chat listed: the name itself
 * (`Claude Sonnet 4.6 (Thinking)`), or a model's name with one of its levels (`Gemini 3.8 Flash (High)`). A name no
 * listed model matches is not a choice the Chat can apply.
 */
export function antigravityChoiceFromName(
    name: string | undefined,
    models: readonly AgentChatModel[],
): AgentChatDefaultChoice {
    if (!name) return {};
    for (const model of models) {
        if (model.displayName === name) return { model: model.id };
        const effort = model.efforts.find(
            (candidate) => `${model.displayName} (${levelName(candidate)})` === name,
        );
        if (effort) return { model: model.id, effort };
    }
    return {};
}

export async function readAntigravityFileDefaults(
    path: string,
    models: readonly AgentChatModel[],
): Promise<AgentChatDefaultChoice> {
    const { model } = await readSettings(path);
    return antigravityChoiceFromName(typeof model === 'string' ? model : undefined, models);
}

/**
 * The names `agy models` lists, one `<id>\t<name>` row per model after a progress line. They are the only spellings
 * `agy` accepts in its settings file.
 */
export async function listAntigravityModelNames(executable: string): Promise<string[]> {
    const { stdout } = await runExternalCommand(executable, ['models'], {
        timeout: 20_000,
        maxBuffer: 256 * 1024,
    });
    return stdout
        .split('\n')
        .map((line) => line.split('\t', 2)[1]?.trim())
        .filter((name): name is string => Boolean(name));
}

/**
 * Writes a default change as the `agy` model name it means, leaving every other key as it was. The model's name with
 * the chosen (or the model's default) level wins when `agy models` lists it, since a levelled model is only listed with
 * its level; otherwise the plain name. `null` for the model removes the key, so `agy`'s own default applies again.
 */
export async function writeAntigravityFileDefaults(
    path: string,
    models: readonly AgentChatModel[],
    names: readonly string[],
    change: { model?: string | null; effort?: string | null },
): Promise<void> {
    const settings = await readSettings(path);
    const current = antigravityChoiceFromName(
        typeof settings.model === 'string' ? settings.model : undefined,
        models,
    );
    const modelId = change.model === undefined ? current.model : (change.model ?? undefined);
    // A level alone needs the model the file names; never drop an unrecognized model to apply it.
    if (modelId === undefined && change.model === undefined && settings.model !== undefined)
        throw new CaxriError('VALIDATION', 'Choose an Antigravity model before its level');
    if (modelId === undefined) delete settings.model;
    else {
        const model = models.find((candidate) => candidate.id === modelId);
        if (!model)
            throw new CaxriError('VALIDATION', `Antigravity does not list the model ${modelId}`);
        const effort =
            (change.effort === undefined ? current.effort : (change.effort ?? undefined)) ??
            model.defaultEffort;
        const listed = new Set(names);
        const levelled =
            effort && model.efforts.includes(effort)
                ? `${model.displayName} (${levelName(effort)})`
                : undefined;
        const name = [levelled, model.displayName].find(
            (candidate) => candidate !== undefined && listed.has(candidate),
        );
        if (!name)
            throw new CaxriError(
                'UNAVAILABLE',
                `Antigravity's model list does not name ${model.displayName}`,
            );
        settings.model = name;
    }
    // `agy` writes this file with two-space indentation and a final newline.
    await atomicWriteUserConfig(path, `${JSON.stringify(settings, null, 2)}\n`);
}

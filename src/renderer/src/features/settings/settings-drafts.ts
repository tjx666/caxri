import { keybindingsFileSchema, settingsFileSchema } from '@shared/config';
import { themeTokensSchema } from '@shared/ipc/domain';
import type { AppSettings, Keybinding, KeybindingConflict, ThemeTokens } from '@shared/types';
import type { ParseError } from 'jsonc-parser';
import { parse, printParseErrorCode } from 'jsonc-parser';

import type { ConfigKind } from './config-edit';
import { CONFIG_FILE_NAMES } from './config-edit';

export interface ConfigState {
    settings: { value: AppSettings | undefined; source: string; appliedSource: string };
    keybindings: {
        value: Keybinding[];
        source: string;
        appliedSource: string;
        conflicts: KeybindingConflict[];
    };
    theme: { value: ThemeTokens | undefined; source: string; appliedSource: string };
}

export const initialConfigState: ConfigState = {
    settings: { value: undefined, source: '', appliedSource: '' },
    keybindings: { value: [], source: '', appliedSource: '', conflicts: [] },
    theme: { value: undefined, source: '', appliedSource: '' },
};

export type ConfigAction =
    | {
          type: 'loaded';
          settings: { value: AppSettings; source: string };
          keybindings: { value: Keybinding[]; source: string; conflicts: KeybindingConflict[] };
          theme: { value: ThemeTokens; source: string };
      }
    | { type: 'settings/changed'; value: AppSettings; source: string }
    | { type: 'settings/sourceChanged'; source: string }
    | { type: 'settings/sourceParsed'; value: AppSettings }
    | { type: 'settings/applied'; value: AppSettings; source: string }
    /**
     * The Runtime reports `settings.jsonc` changed on disk (an external editor, or our own write echoing back). `value`
     * is omitted when the new text fails to parse, so a foreign edit that breaks the file surfaces its error without
     * discarding the last-known-good structured value.
     */
    | { type: 'settings/externalChanged'; source: string; value?: AppSettings }
    | { type: 'keybindings/changed'; value: Keybinding[]; source: string }
    | { type: 'keybindings/sourceChanged'; source: string }
    | { type: 'keybindings/sourceParsed'; value: Keybinding[] }
    | {
          type: 'keybindings/applied';
          value: Keybinding[];
          source: string;
          conflicts: KeybindingConflict[];
      }
    | {
          type: 'keybindings/externalChanged';
          source: string;
          value?: Keybinding[];
          conflicts?: KeybindingConflict[];
      }
    | { type: 'theme/changed'; value: ThemeTokens; source: string }
    | { type: 'theme/sourceChanged'; source: string }
    | { type: 'theme/sourceParsed'; value: ThemeTokens }
    | { type: 'theme/applied'; value: ThemeTokens; source: string }
    | { type: 'theme/externalChanged'; source: string; value?: ThemeTokens }
    | { type: 'theme/imported'; value: ThemeTokens; source: string };

export function configReducer(state: ConfigState, action: ConfigAction): ConfigState {
    switch (action.type) {
        case 'loaded':
            return {
                settings: {
                    value: action.settings.value,
                    source: action.settings.source,
                    appliedSource: action.settings.source,
                },
                keybindings: {
                    value: action.keybindings.value,
                    source: action.keybindings.source,
                    appliedSource: action.keybindings.source,
                    conflicts: action.keybindings.conflicts,
                },
                theme: {
                    value: action.theme.value,
                    source: action.theme.source,
                    appliedSource: action.theme.source,
                },
            };
        case 'settings/changed':
            return {
                ...state,
                settings: { ...state.settings, value: action.value, source: action.source },
            };
        case 'settings/sourceChanged':
            return { ...state, settings: { ...state.settings, source: action.source } };
        case 'settings/sourceParsed':
            return { ...state, settings: { ...state.settings, value: action.value } };
        case 'settings/applied':
            return {
                ...state,
                settings: {
                    value: action.value,
                    source: action.source,
                    appliedSource: action.source,
                },
            };
        case 'settings/externalChanged':
            return {
                ...state,
                settings: {
                    value: action.value ?? state.settings.value,
                    source: action.source,
                    appliedSource: action.source,
                },
            };
        case 'keybindings/changed':
            return {
                ...state,
                keybindings: { ...state.keybindings, value: action.value, source: action.source },
            };
        case 'keybindings/sourceChanged':
            return { ...state, keybindings: { ...state.keybindings, source: action.source } };
        case 'keybindings/sourceParsed':
            return { ...state, keybindings: { ...state.keybindings, value: action.value } };
        case 'keybindings/applied':
            return {
                ...state,
                keybindings: {
                    value: action.value,
                    source: action.source,
                    appliedSource: action.source,
                    conflicts: action.conflicts,
                },
            };
        case 'keybindings/externalChanged':
            return {
                ...state,
                keybindings: {
                    value: action.value ?? state.keybindings.value,
                    source: action.source,
                    appliedSource: action.source,
                    conflicts: action.conflicts ?? state.keybindings.conflicts,
                },
            };
        case 'theme/changed':
            return {
                ...state,
                theme: { ...state.theme, value: action.value, source: action.source },
            };
        case 'theme/sourceChanged':
            return { ...state, theme: { ...state.theme, source: action.source } };
        case 'theme/sourceParsed':
            return { ...state, theme: { ...state.theme, value: action.value } };
        case 'theme/applied':
            return {
                ...state,
                theme: { value: action.value, source: action.source, appliedSource: action.source },
            };
        case 'theme/externalChanged':
            return {
                ...state,
                theme: {
                    value: action.value ?? state.theme.value,
                    source: action.source,
                    appliedSource: action.source,
                },
            };
        case 'theme/imported':
            return {
                ...state,
                theme: {
                    value: action.value,
                    source: action.source,
                    appliedSource: action.source,
                },
            };
        default:
            return state;
    }
}

interface ConfigValues {
    settings: AppSettings;
    keybindings: Keybinding[];
    theme: ThemeTokens;
}

export type ConfigParseResult<Kind extends ConfigKind> =
    { ok: true; value: ConfigValues[Kind] } | { ok: false; error: string };

function parseJsonc(source: string): { ok: true; value: unknown } | { ok: false; error: string } {
    const errors: ParseError[] = [];
    const value: unknown = parse(source, errors, {
        allowTrailingComma: true,
        disallowComments: false,
    });
    const first = errors[0];
    if (!first) return { ok: true, value };
    const before = source.slice(0, first.offset).split('\n');
    return {
        ok: false,
        error: `${printParseErrorCode(first.error)} at line ${before.length}, column ${(before.at(-1)?.length ?? 0) + 1}`,
    };
}

/**
 * Parses one in-memory draft without rewriting its comments or formatting.
 */
export function parseConfigSource<Kind extends ConfigKind>(
    kind: Kind,
    source: string,
): ConfigParseResult<Kind> {
    const parsed = parseJsonc(source);
    if (!parsed.ok) return { ok: false, error: `${CONFIG_FILE_NAMES[kind]}: ${parsed.error}` };
    const schema =
        kind === 'settings'
            ? settingsFileSchema
            : kind === 'keybindings'
              ? keybindingsFileSchema
              : themeTokensSchema;
    const result = schema.safeParse(parsed.value);
    if (result.success) {
        return { ok: true, value: result.data as ConfigValues[Kind] };
    }
    const issue = result.error.issues[0];
    const path = issue?.path.length ? `${issue.path.map(String).join('.')}: ` : '';
    return {
        ok: false,
        error: `${CONFIG_FILE_NAMES[kind]}: ${path}${issue?.message ?? 'Invalid configuration'}`,
    };
}

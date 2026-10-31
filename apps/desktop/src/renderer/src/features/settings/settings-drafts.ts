import type {
    AppSettings,
    Keybinding,
    KeybindingConflict,
    ThemeImportWarning,
    ThemeTokens,
} from '@caxri/protocol';
import { appSettingsFileSchema, keybindingsFileSchema, themeTokensSchema } from '@caxri/protocol';
import type { ParseError } from 'jsonc-parser';
import { parse, printParseErrorCode } from 'jsonc-parser';

import type { TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import type { ConfigKind } from './config-edit';
import { CONFIG_FILE_NAMES, CONFIG_KINDS } from './config-edit';

export interface ConfigState {
    settings: { value: AppSettings | undefined; source: string; appliedSource: string };
    keybindings: {
        value: Keybinding[];
        source: string;
        appliedSource: string;
        conflicts: KeybindingConflict[];
    };
    theme: {
        value: ThemeTokens | undefined;
        source: string;
        appliedSource: string;
        warnings: ThemeImportWarning[];
    };
}

export const initialConfigState: ConfigState = {
    settings: { value: undefined, source: '', appliedSource: '' },
    keybindings: { value: [], source: '', appliedSource: '', conflicts: [] },
    theme: { value: undefined, source: '', appliedSource: '', warnings: [] },
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
    | { type: 'settings/echoApplied'; source: string }
    | { type: 'settings/reconciled'; value: AppSettings; source: string }
    /**
     * An external editor changed `settings.jsonc` on disk. Local-write echoes are consumed before this action; `value`
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
    | { type: 'keybindings/echoApplied'; source: string }
    | {
          type: 'keybindings/reconciled';
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
    | { type: 'theme/echoApplied'; source: string }
    | { type: 'theme/reconciled'; value: ThemeTokens; source: string }
    | { type: 'theme/externalChanged'; source: string; value?: ThemeTokens }
    | {
          type: 'theme/imported';
          value: ThemeTokens;
          source: string;
          warnings: ThemeImportWarning[];
      };

/**
 * Keep importer diagnostics visible when a serialized read returns the same theme without them.
 */
function keepSessionThemeWarnings(
    current: ConfigState['theme'],
    next: ThemeTokens,
): ThemeImportWarning[] {
    return current.value?.id === next.id ? current.warnings : [];
}

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
                    warnings: [],
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
        case 'settings/echoApplied':
            return {
                ...state,
                settings: { ...state.settings, appliedSource: action.source },
            };
        case 'settings/reconciled': {
            const hasPendingDraft = state.settings.source !== state.settings.appliedSource;
            return {
                ...state,
                settings: {
                    value: hasPendingDraft ? state.settings.value : action.value,
                    source: hasPendingDraft ? state.settings.source : action.source,
                    appliedSource: action.source,
                },
            };
        }
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
        case 'keybindings/echoApplied':
            return {
                ...state,
                keybindings: { ...state.keybindings, appliedSource: action.source },
            };
        case 'keybindings/reconciled': {
            const hasPendingDraft = state.keybindings.source !== state.keybindings.appliedSource;
            return {
                ...state,
                keybindings: {
                    value: hasPendingDraft ? state.keybindings.value : action.value,
                    source: hasPendingDraft ? state.keybindings.source : action.source,
                    appliedSource: action.source,
                    conflicts: hasPendingDraft ? state.keybindings.conflicts : action.conflicts,
                },
            };
        }
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
                theme: {
                    ...state.theme,
                    value: action.value,
                    source: action.source,
                    warnings: [],
                },
            };
        case 'theme/sourceChanged':
            return { ...state, theme: { ...state.theme, source: action.source } };
        case 'theme/sourceParsed':
            return {
                ...state,
                theme: {
                    ...state.theme,
                    value: action.value,
                    warnings: keepSessionThemeWarnings(state.theme, action.value),
                },
            };
        case 'theme/applied':
            return {
                ...state,
                theme: {
                    value: action.value,
                    source: action.source,
                    appliedSource: action.source,
                    warnings: keepSessionThemeWarnings(state.theme, action.value),
                },
            };
        case 'theme/echoApplied':
            return {
                ...state,
                theme: { ...state.theme, appliedSource: action.source },
            };
        case 'theme/reconciled': {
            const hasPendingDraft = state.theme.source !== state.theme.appliedSource;
            return {
                ...state,
                theme: {
                    value: hasPendingDraft ? state.theme.value : action.value,
                    source: hasPendingDraft ? state.theme.source : action.source,
                    appliedSource: action.source,
                    warnings: keepSessionThemeWarnings(state.theme, action.value),
                },
            };
        }
        case 'theme/externalChanged':
            return {
                ...state,
                theme: {
                    value: action.value ?? state.theme.value,
                    source: action.source,
                    appliedSource: action.source,
                    warnings: action.value
                        ? keepSessionThemeWarnings(state.theme, action.value)
                        : state.theme.warnings,
                },
            };
        case 'theme/imported':
            return {
                ...state,
                theme: {
                    value: action.value,
                    source: action.source,
                    appliedSource: action.source,
                    warnings: action.warnings,
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

export interface ConfigSourceError {
    error: string;
    line?: number;
}

export type ConfigParseResult<Kind extends ConfigKind> =
    { ok: true; value: ConfigValues[Kind] } | ({ ok: false } & ConfigSourceError);

/**
 * Parse errors are shown in the source view and computed from event handlers, so they translate through `translate()`
 * when raised rather than through a hook.
 */
const PARSE_ERROR_DESCRIPTIONS: Record<ReturnType<typeof printParseErrorCode>, TranslationKey> = {
    'InvalidSymbol': 'settings.source.parseError.invalidSymbol',
    'InvalidNumberFormat': 'settings.source.parseError.invalidNumberFormat',
    'PropertyNameExpected': 'settings.source.parseError.propertyNameExpected',
    'ValueExpected': 'settings.source.parseError.valueExpected',
    'ColonExpected': 'settings.source.parseError.colonExpected',
    'CommaExpected': 'settings.source.parseError.commaExpected',
    'CloseBraceExpected': 'settings.source.parseError.closeBraceExpected',
    'CloseBracketExpected': 'settings.source.parseError.closeBracketExpected',
    'EndOfFileExpected': 'settings.source.parseError.endOfFileExpected',
    'InvalidCommentToken': 'settings.source.parseError.invalidCommentToken',
    'UnexpectedEndOfComment': 'settings.source.parseError.unexpectedEndOfComment',
    'UnexpectedEndOfString': 'settings.source.parseError.unexpectedEndOfString',
    'UnexpectedEndOfNumber': 'settings.source.parseError.unexpectedEndOfNumber',
    'InvalidUnicode': 'settings.source.parseError.invalidUnicode',
    'InvalidEscapeCharacter': 'settings.source.parseError.invalidEscapeCharacter',
    'InvalidCharacter': 'settings.source.parseError.invalidCharacter',
    '<unknown ParseErrorCode>': 'settings.source.parseError.unknown',
};

function parseJsonc(
    source: string,
): { ok: true; value: unknown } | { ok: false; error: string; line: number } {
    const errors: ParseError[] = [];
    const value: unknown = parse(source, errors, {
        allowTrailingComma: true,
        disallowComments: false,
    });
    // `.at(0)` (rather than `[0]`) keeps the possibly-empty array's `undefined` case in the type, since this project
    // does not enable `noUncheckedIndexedAccess`.
    const first = errors.at(0);
    if (!first) return { ok: true, value };
    const before = source.slice(0, first.offset).split('\n');
    return {
        ok: false,
        error: translate('settings.source.parseLocation', {
            column: (before.at(-1)?.length ?? 0) + 1,
            description: translate(PARSE_ERROR_DESCRIPTIONS[printParseErrorCode(first.error)]),
            line: before.length,
        }),
        line: before.length,
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
    if (!parsed.ok)
        return {
            ok: false,
            error: `${CONFIG_FILE_NAMES[kind]}: ${parsed.error}`,
            line: parsed.line,
        };
    const schema =
        kind === 'settings'
            ? appSettingsFileSchema
            : kind === 'keybindings'
              ? keybindingsFileSchema
              : themeTokensSchema;
    const result = schema.safeParse(parsed.value);
    if (result.success) {
        return { ok: true, value: result.data as ConfigValues[Kind] };
    }
    // `.at(0)` (rather than `[0]`) keeps the possibly-empty array's `undefined` case in the type, since this project
    // does not enable `noUncheckedIndexedAccess`.
    const issue = result.error.issues.at(0);
    const path = issue?.path.length ? `${issue.path.map(String).join('.')}: ` : '';
    return {
        ok: false,
        error: `${CONFIG_FILE_NAMES[kind]}: ${path}${issue?.message ?? translate('settings.source.invalidConfiguration')}`,
    };
}

/**
 * The first configuration file whose Source draft differs from what was applied and does not parse, so it can never be
 * written. Settings stays mounted while hidden, so such a draft survives closing the page; this is what the close
 * warning names and where the next untargeted open lands, instead of the edit silently sitting behind the UI view.
 */
export function invalidSourceDraft(state: ConfigState): ConfigKind | undefined {
    return CONFIG_KINDS.find(
        (kind) =>
            state[kind].source !== state[kind].appliedSource &&
            !parseConfigSource(kind, state[kind].source).ok,
    );
}

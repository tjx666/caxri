import type { AgentProvider, SettingCategoryId, SettingKey, SettingSpec } from '@caxri/protocol';
import { settingsSpecByKey } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';

/**
 * How a Settings row reads and writes its value. Scalar `settings.jsonc` fields render a generic control from their
 * spec; everything else (argv-backed toggles, provider sub-fields, dedicated editors, action buttons) declares an
 * explicit binding the row renderer dispatches on.
 */
export type SettingRowBinding =
    | { type: 'setting'; key: SettingKey }
    | {
          type: 'provider-toggle';
          provider: AgentProvider;
          field: 'hooks' | 'messaging';
      }
    | { type: 'provider-recovery'; provider: AgentProvider }
    | { type: 'provider-autonomy'; provider: AgentProvider }
    | { type: 'provider-launch'; provider: AgentProvider; field: 'executable' | 'args' }
    | { type: 'provider-actions'; provider: AgentProvider }
    | { type: 'provider-skill-health'; provider: AgentProvider }
    | { type: 'trusted-domains' }
    | { type: 'trusted-folders' }
    | { type: 'terminal-reference-links' }
    | { type: 'ignored-checks' }
    | { type: 'long-running-commands' }
    | { type: 'files-exclude'; key: 'files.exclude' | 'git.diffExclude' }
    | { type: 'archived-sessions' }
    | { type: 'mobile-access' }
    | { type: 'ssh-hosts' }
    | { type: 'host-names' }
    | { type: 'claude-windows' }
    | { type: 'agent-secrets' }
    | { type: 'delegation-presets' }
    | {
          type: 'delegation-field';
          field: 'approval' | 'autoHandBack' | 'maxDepth' | 'readChildChat';
      }
    | { type: 'remote-debugging' }
    | { type: 'hardware-acceleration' };

/**
 * A titled group of rows inside a category, rendered as a heading over its own card.
 *
 * - `group` splits a short category into themed cards (General's Workspace, Sessions, Appearance, Sidebar). The whole
 *   category fits a screen or two, so its groups stay out of the Settings navigation, which would otherwise list four
 *   entries for one page.
 * - `provider` is one Agent's section under Agents: long enough that the navigation lists it, and headed by that Agent's
 *   identity icon. Provider names are never translated.
 */
export type SettingSubcategorySource =
    | { kind: 'group'; id: string; titleKey: TranslationKey }
    | { kind: 'provider'; id: AgentProvider };

/**
 * A row as declared, before the registry translates it for a locale. Visible text is stored as translation keys so the
 * registry can render it in the active language; `searchTerms` holds the English corpus (the protocol catalog's text,
 * its keywords, and hand-picked synonyms), which stays searchable in every language.
 */
export interface SettingRowSource {
    /**
     * Stable unique id: the settings key, or a purpose-named id for non-settings rows.
     */
    id: string;
    category: SettingCategoryId;
    /**
     * The group the row belongs to inside its category. A category's rows with no subcategory come first, and each
     * subcategory's rows stay contiguous, because the list emits a heading wherever the subcategory changes.
     */
    subcategory?: SettingSubcategorySource;
    titleKey: TranslationKey;
    descriptionKey?: TranslationKey;
    detailKey?: TranslationKey;
    /**
     * A boolean setting this row only applies under. While that switch is off the row's control is disabled, so a
     * dependent value (Suspend idle Agents after) cannot read as if it were in force. Honored by the generic boolean
     * and integer controls of a `setting` binding.
     */
    enabledBy?: SettingKey;
    binding: SettingRowBinding;
    /**
     * Hidden from the Settings list until the user turns on Show advanced settings: launch arguments, hooks, recovery
     * rules, rendering internals, and other values a new user never needs to see first. Search still finds it, so every
     * advanced row stays reachable and resettable.
     */
    advanced?: boolean;
    /**
     * Catalog entry whose translated text (title, description, option labels) also joins the row's search corpus.
     */
    searchSpec?: SettingKey;
    /**
     * English search corpus, lowercased.
     */
    searchTerms: string;
}

type DescribedSettingKey = Extract<
    (typeof settingsSpecByKey)[SettingKey],
    { description: string }
>['key'];

export const lower = (values: Array<string | undefined>): string =>
    values
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLowerCase();

export function specSearchTerms(spec: SettingSpec, extra: string[] = []): string {
    return lower([
        spec.title,
        spec.description,
        spec.key,
        ...(spec.keywords ?? []),
        ...(spec.kind === 'enum' ? spec.options.map((option) => option.label) : []),
        ...extra,
    ]);
}

export function specRow(key: SettingKey, extra?: Partial<SettingRowSource>): SettingRowSource {
    const spec: SettingSpec = settingsSpecByKey[key];
    return {
        id: spec.key,
        category: spec.category,
        titleKey: `settings.${key}.title`,
        descriptionKey:
            spec.description === undefined
                ? undefined
                : `settings.${key as DescribedSettingKey}.description`,
        binding: { type: 'setting', key },
        searchSpec: key,
        searchTerms: specSearchTerms(spec),
        ...extra,
    };
}

import type { ThemeImportWarning } from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { formatList } from '../../lib/list-format';

const WARNING_KEYS = {
    'terminal-palette-fallback': 'settings.themeEditor.warning.terminalPaletteFallback',
    'other-syntax-colors': 'settings.themeEditor.warning.otherSyntaxColors',
    'semantic-token-colors': 'settings.themeEditor.warning.semanticTokenColors',
    'iterm-terminal-only': 'settings.themeEditor.warning.itermTerminalOnly',
    'warp-visual-effects': 'settings.themeEditor.warning.warpVisualEffects',
} as const satisfies Record<string, TranslationKey>;

const SYNTAX_ROLE_KEYS = {
    comment: 'settings.themeEditor.warning.role.comment',
    keyword: 'settings.themeEditor.warning.role.keyword',
    string: 'settings.themeEditor.warning.role.string',
    number: 'settings.themeEditor.warning.role.number',
} as const satisfies Record<string, TranslationKey>;

function isSyntaxRole(role: string): role is keyof typeof SYNTAX_ROLE_KEYS {
    return role in SYNTAX_ROLE_KEYS;
}

function isKnownWarning(id: string): id is keyof typeof WARNING_KEYS {
    return id in WARNING_KEYS;
}

/**
 * The warning text in the interface language. The Server sends a closed `id` plus `params`; an id this build does not
 * know falls back to the Server's English `message` rather than showing nothing.
 */
export function themeImportWarningText(warning: ThemeImportWarning, t: Translate): string {
    if (warning.id === 'missing-syntax-colors') {
        const roles = (warning.params?.roles ?? '').split(',').filter(isSyntaxRole);
        if (roles.length === 0) return t('settings.themeEditor.warning.missingSyntaxColors');
        return t('settings.themeEditor.warning.missingSyntaxColorsFor', {
            roles: formatList(
                roles.map((role) => t(SYNTAX_ROLE_KEYS[role])),
                t.locale,
            ),
        });
    }
    if (isKnownWarning(warning.id)) return t(WARNING_KEYS[warning.id], warning.params);
    return warning.message;
}

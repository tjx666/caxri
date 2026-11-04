import { cn } from '../../lib/utilities';
import type { SettingsCardPosition } from './settings-search';

/**
 * Class names that draw one row's slice of its card (see `SettingsCardPosition`). The hairline outline keeps a card
 * visible in a theme whose `--surface` matches `--background` (Oscura Midnight); a slice's top edge is the card's top
 * outline or the divider above the row.
 */
export function cardSliceClassName(card: SettingsCardPosition): string {
    return cn(
        'border-x border-t border-border bg-surface',
        card.first && 'rounded-t-md',
        card.last && 'rounded-b-md border-b',
    );
}

/**
 * A card that holds a single group, such as the Theme tab's swatch grid: the whole outline in one box.
 */
export const SETTINGS_SOLO_CARD_CLASS_NAME = cardSliceClassName({ first: true, last: true });

/**
 * The centered column every Settings tab lays its content in, as macOS System Settings does: a wide window keeps each
 * label within reach of its control instead of stretching the row across the screen.
 */
export const SETTINGS_COLUMN_CLASS_NAME = 'mx-auto w-full max-w-3xl';

/**
 * A group heading above a card (a category in the Settings list, a section of the Theme tab). `legend` and `h2` share
 * it so the tabs read as one design.
 */
export const SETTINGS_GROUP_HEADING_CLASS_NAME =
    'm-0 px-1 pb-3 text-[15px] font-semibold text-foreground';

/**
 * A smaller heading inside a group (a subcategory in the Settings list, a command category in Keybindings).
 */
export const SETTINGS_SUBGROUP_HEADING_CLASS_NAME =
    'm-0 px-1 pb-2 text-[12px] font-medium text-muted';

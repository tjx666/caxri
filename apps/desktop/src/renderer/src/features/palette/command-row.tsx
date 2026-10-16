import type { commandDefinitions, ViewCatalogSnapshot } from '@caxri/protocol';

import { executeCommand } from '../../commands/execute';
import { ShortcutBadge } from '../../components/shortcut-badge';
import { CommandItem } from '../../components/ui/command';
import { useTranslation } from '../../i18n';
import { commandCategory, commandDescription, commandTitle } from '../../lib/command-labels';
import { useCommandShortcut } from '../../lib/keybindings';
import { setPaletteOpen } from '../../stores/dialogs';
import { didExecuteViewCatalogCommand } from '../view-containers/view-container-commands';
import type { CommandTitleContext } from './command-palette-commands';
import { paletteCommandTitle } from './command-palette-commands';

export const commandItemMetaClassName =
    'inline-flex flex-none items-center gap-2 text-[11px] text-muted';

/**
 * Every command already carries a plain-language `description` in the shared catalog (e.g. Screencast Mode's explains
 * it overlays clicks/keystrokes without hiding anything), but nothing in the palette ever rendered it. Showing it as a
 * secondary line benefits every command, not just the ones whose title alone is ambiguous.
 */
export function CommandRow({
    command,
    titleContext,
    value,
}: {
    command: (typeof commandDefinitions)[number];
    titleContext: CommandTitleContext;
    value: string;
}) {
    const { t } = useTranslation();
    const shortcut = useCommandShortcut(command.id);
    return (
        <CommandItem
            value={value}
            onSelect={() => {
                setPaletteOpen(false);
                executeCommand(command.id);
            }}
        >
            <span className="flex min-w-0 flex-col gap-0.5">
                <span>{paletteCommandTitle(command, titleContext, t)}</span>
                <span className="truncate text-[11px] text-muted">
                    {commandDescription(command, t)}
                </span>
            </span>
            <small className={commandItemMetaClassName}>
                {commandCategory(command.category, t)}
                {shortcut && (
                    <ShortcutBadge
                        compact
                        keyClassName="group-data-[selected=true]:bg-[var(--selection)]"
                        shortcut={shortcut}
                    />
                )}
            </small>
        </CommandItem>
    );
}

export function DynamicCommandRow({
    catalog,
    command,
    value,
}: {
    catalog: ViewCatalogSnapshot;
    command: { id: string; title: string; description?: string };
    value: string;
}) {
    const { t } = useTranslation();
    return (
        <CommandItem
            value={value}
            onSelect={() => {
                setPaletteOpen(false);
                didExecuteViewCatalogCommand(catalog, command.id);
            }}
        >
            <span className="flex min-w-0 flex-col gap-0.5">
                <span>{commandTitle(command, t)}</span>
                {command.description && (
                    <span className="truncate text-[11px] text-muted">{command.description}</span>
                )}
            </span>
            <small className={commandItemMetaClassName}>{t('palette.source.extension')}</small>
        </CommandItem>
    );
}

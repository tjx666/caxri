import type {
    CommandDefinition,
    CommandWhen,
    ContributedCommandDescriptor,
    ViewCatalogSnapshot,
} from '@caxri/protocol';
import { commandDefinitions } from '@caxri/protocol';

const STATIC_COMMAND_IDS: ReadonlySet<string> = new Set(commandDefinitions.map(({ id }) => id));

export type CommandPaletteWhenContext = Readonly<Record<CommandWhen, boolean>>;

/**
 * Hides commands whose `when` predicate is false for the current selection so the palette stays in sync with the
 * row-menu's disabled affordance. Commands without `when` remain visible.
 */
export function isCommandVisibleInPalette(
    command: CommandDefinition,
    context: CommandPaletteWhenContext,
): boolean {
    return command.when === undefined || context[command.when];
}

export function getStaticCommandPaletteValue(command: CommandDefinition): string {
    return [
        command.category,
        command.title,
        command.id,
        command.description,
        ...(command.keywords ?? []),
    ].join(' ');
}

/**
 * Returns catalog commands that have a unique palette entry. Workbench Core and extension contributions share this
 * generic path; static command rows remain canonical when either source intentionally reuses a legacy command id.
 */
export function getPaletteExtensionCommands(
    catalog: ViewCatalogSnapshot | undefined,
): readonly ContributedCommandDescriptor[] {
    return (
        catalog?.commands.filter(
            (command) =>
                command.source.kind !== 'builtin' &&
                command.palette !== false &&
                !STATIC_COMMAND_IDS.has(command.id),
        ) ?? []
    );
}

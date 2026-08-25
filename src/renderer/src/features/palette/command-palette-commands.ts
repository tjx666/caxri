import { commandDefinitions } from '@shared/commands';
import type { ContributedCommandDescriptor, ViewCatalogSnapshot } from '@shared/views';

const STATIC_COMMAND_IDS: ReadonlySet<string> = new Set(commandDefinitions.map(({ id }) => id));

/**
 * Returns extension commands that have a unique palette entry. Commands contributed by an extension can intentionally
 * reuse a shared legacy command id (for example, a view action), but the static command row remains the canonical
 * palette entry for that id.
 */
export function getPaletteExtensionCommands(
    catalog: ViewCatalogSnapshot | undefined,
): readonly ContributedCommandDescriptor[] {
    return (
        catalog?.commands.filter(
            (command) => command.source.kind === 'extension' && !STATIC_COMMAND_IDS.has(command.id),
        ) ?? []
    );
}

import { commandDefinitions } from '@shared/commands';
import type { ContributedCommandDescriptor, ViewCatalogSnapshot } from '@shared/views';

const STATIC_COMMAND_IDS: ReadonlySet<string> = new Set(commandDefinitions.map(({ id }) => id));

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

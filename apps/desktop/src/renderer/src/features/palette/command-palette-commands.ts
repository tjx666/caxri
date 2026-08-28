import type {
    CommandDefinition,
    ContributedCommandDescriptor,
    ViewCatalogSnapshot,
} from '@caxri/protocol';
import { commandDefinitions } from '@caxri/protocol';

const STATIC_COMMAND_IDS: ReadonlySet<string> = new Set(commandDefinitions.map(({ id }) => id));

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

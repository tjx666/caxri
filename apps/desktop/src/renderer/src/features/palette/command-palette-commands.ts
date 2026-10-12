import type {
    CommandDefinition,
    CommandId,
    CommandWhen,
    ContributedCommandDescriptor,
    ViewCatalogSnapshot,
} from '@caxri/protocol';
import { commandDefinitions } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { commandCategory, commandDescription, commandTitle } from '../../lib/command-labels';

const STATIC_COMMAND_IDS: ReadonlySet<string> = new Set(commandDefinitions.map(({ id }) => id));

export type CommandPaletteWhenContext = Readonly<Record<CommandWhen, boolean>>;

/**
 * What a contextual title may depend on. Kept to plain facts the palette derives from its own store reads, so a
 * resolver stays a pure function the palette can call on every render.
 */
export interface CommandTitleContext {
    /**
     * Restarting the active Terminal resumes an Agent conversation (the recovery row's "Restart Agent").
     */
    readonly activeTerminalRestartsAgent: boolean;
}

/**
 * Commands whose palette title follows the current context. The catalog title stays static because Main builds the
 * native menu from it once; a resolver returns `undefined` to keep that catalog title.
 */
const contextualTitleResolvers: Partial<
    Record<CommandId, (context: CommandTitleContext, t: Translate) => string | undefined>
> = {
    'terminal.restart': (context, t) =>
        context.activeTerminalRestartsAgent ? t('terminal.recovery.restartAgent') : undefined,
};

/**
 * The title a palette row shows: the contextual title when one applies, otherwise the translated catalog title.
 */
export function paletteCommandTitle(
    command: CommandDefinition,
    context: CommandTitleContext,
    t: Translate,
): string {
    return contextualTitleResolvers[command.id]?.(context, t) ?? commandTitle(command, t);
}

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

/**
 * Offers Hand Over to Agent Commander or Take Back from it for the selected Session, matching the choice its row menu
 * makes. Until the managed set is read (`managedSessionIds` undefined) the palette offers Hand Over, which the Server
 * refuses as `already_managed` if that was wrong. An SSH Host window offers neither: the Commander is local-only.
 */
export function commanderPaletteWhenContext({
    isLocalOnlyAvailable,
    managedSessionIds,
    selectedSessionId,
}: {
    isLocalOnlyAvailable: boolean;
    managedSessionIds: readonly string[] | undefined;
    selectedSessionId: string | undefined;
}): Pick<CommandPaletteWhenContext, 'commanderHandOverAvailable' | 'commanderTakeBackAvailable'> {
    const isManaged =
        selectedSessionId !== undefined && managedSessionIds?.includes(selectedSessionId) === true;
    return {
        commanderHandOverAvailable: isLocalOnlyAvailable && !isManaged,
        commanderTakeBackAvailable: isLocalOnlyAvailable && isManaged,
    };
}

/**
 * The search value always carries the English catalog copy, so an English query finds a command in any language; with
 * `t`, the translated title, category, and description are appended when they differ from English.
 */
export function getStaticCommandPaletteValue(
    command: CommandDefinition,
    t?: Translate,
    titleContext?: CommandTitleContext,
): string {
    const translated = t
        ? [
              commandCategory(command.category, t),
              titleContext
                  ? paletteCommandTitle(command, titleContext, t)
                  : commandTitle(command, t),
              commandDescription(command, t),
          ].filter(
              (text) =>
                  text !== undefined &&
                  text !== command.category &&
                  text !== command.title &&
                  text !== command.description,
          )
        : [];
    return [
        command.category,
        command.title,
        command.id,
        command.description,
        ...(command.keywords ?? []),
        ...translated,
    ].join(' ');
}

/**
 * Search value for a View catalog or extension command row: English title plus its translation when one exists.
 */
export function getDynamicCommandPaletteValue(
    command: { id: string; title: string; description?: string },
    t: Translate,
): string {
    const title = commandTitle(command, t);
    return [
        'Extension',
        command.title,
        command.id,
        command.description ?? '',
        ...(title === command.title ? [] : [title]),
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

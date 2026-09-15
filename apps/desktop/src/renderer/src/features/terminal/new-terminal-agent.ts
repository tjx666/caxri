import type { AppSettings, TerminalKind } from '@caxri/protocol';
import { terminalKindSchema } from '@caxri/protocol';

/**
 * The value `session.defaultAgent` holds: an Agent, `shell`, or `null` when the user never named one.
 */
type ConfiguredDefaultAgent = AppSettings['session.defaultAgent'] | undefined;

/**
 * Every kind a new Terminal can start as, in the protocol catalog's declaration order with `shell` last.
 *
 * The order is fixed on purpose. A menu that reorders itself by recency costs the user the muscle memory that makes the
 * second use of a control cheaper than the first, and this list is short enough that recency buys nothing. VS Code
 * builds its own New Terminal dropdown from the profile catalog the same way
 * (`src/vs/workbench/contrib/terminal/browser/terminalMenus.ts`, `getTerminalActionBarArgs`).
 */
const NEW_TERMINAL_KIND_CATALOG: readonly TerminalKind[] = terminalKindSchema.options;

/**
 * What a new Terminal falls back to when the user configured no default Agent: the behavior every in-Session entry
 * point had before `session.defaultAgent` was read here at all.
 */
const FALLBACK_NEW_TERMINAL_KIND: TerminalKind = 'shell';

export interface NewTerminalAgentChoice {
    /**
     * True for the kind the split button's primary half creates on its own, so the menu can mark it the way VS Code
     * marks its default profile.
     */
    isDefault: boolean;
    kind: TerminalKind;
}

/**
 * The Agent a new in-Session Terminal starts with, or `null` when the user configured none.
 *
 * `null` is not "shell". The setting presents that value as "Ask each time" (`settings-spec.ts`, `nullLabel`), so the
 * entry points answer it by asking wherever they can: the split button opens its menu, and only the `terminal.new`
 * command — which has no menu to open from a shortcut — falls back to a shell (see `newTerminalCommandKind`).
 */
export function resolveNewTerminalAgent(defaultAgent: ConfiguredDefaultAgent): TerminalKind | null {
    return defaultAgent ?? null;
}

/**
 * What `terminal.new` and `terminal.newInSplit` create. A command has to create something: it can be invoked from a
 * shortcut, the palette, or the native menu, none of which guarantee a mounted button whose menu could be opened
 * instead.
 */
export function newTerminalCommandKind(defaultAgent: ConfiguredDefaultAgent): TerminalKind {
    return resolveNewTerminalAgent(defaultAgent) ?? FALLBACK_NEW_TERMINAL_KIND;
}

/**
 * Every kind the split button's dropdown offers, in catalog order, with the configured default marked. Nothing here
 * depends on what was picked last, so the list a user learns once stays where they learned it.
 */
export function newTerminalAgentChoices(
    defaultAgent: ConfiguredDefaultAgent,
): NewTerminalAgentChoice[] {
    const configured = resolveNewTerminalAgent(defaultAgent);
    return NEW_TERMINAL_KIND_CATALOG.map((kind) => ({ isDefault: kind === configured, kind }));
}

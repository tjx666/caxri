import type { AppSettings, TerminalKind, TerminalRecord } from '@caxri/protocol';
import { terminalKindSchema } from '@caxri/protocol';

import { getTerminalExitPresentation } from './terminal-exit-presentation';

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
 * command (which has no menu to open from a shortcut) falls back to a shell (see `newTerminalCommandKind`).
 */
export function resolveNewTerminalAgent(defaultAgent: ConfiguredDefaultAgent): TerminalKind | null {
    return defaultAgent ?? null;
}

/**
 * Whether `terminal` currently answers "what Agent is this Session running": not a plain shell, and not sitting in any
 * state {@link getTerminalExitPresentation} recognizes as exited, failed, or otherwise paused. A shell, or an Agent that
 * has since stopped, tells {@link resolveNewTerminalTarget} nothing worth cloning into a new Terminal.
 */
function isLiveAgentTerminal(terminal: TerminalRecord): boolean {
    return (
        terminal.kind !== 'shell' &&
        getTerminalExitPresentation(terminal.lastProcessState) === undefined
    );
}

/**
 * What a direct click on the tab-strip New Terminal `+` creates: the Agent the Session's primary Terminal is currently
 * running, so the new Terminal joins the same conversation instead of always asking or always following a possibly
 * stale configured default (Fix #1292).
 *
 * Falls through to the configured default Agent when the primary Terminal is a shell or has exited, and to `null` when
 * neither resolves: the button opens the Agent list rather than guessing.
 *
 * Deliberately not shared with {@link newTerminalCommandKind}: `⌘T`/`terminal.new` is a global shortcut with no
 * Session-scoped button to read a Primary Agent Terminal from at the call site, and dozens of E2E specs already rely on
 * it answering the configured default (or a shell) regardless of what a Session's other Terminals are doing; see
 * `pressNewTerminal` in `e2e/support/helpers.ts`. The `CommandTooltip` on this button still names `⌘T` as its shortcut
 * because both create _a_ Terminal in the current Session from the same tab-strip slot; the two can name a different
 * Agent only when a live primary Agent Terminal differs from the configured default, which is the uncommon case this
 * button exists to shortcut past.
 */
export function resolveNewTerminalTarget(
    primaryTerminal: TerminalRecord | undefined,
    defaultAgent: ConfiguredDefaultAgent,
): TerminalKind | null {
    if (primaryTerminal && isLiveAgentTerminal(primaryTerminal)) return primaryTerminal.kind;
    return resolveNewTerminalAgent(defaultAgent);
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

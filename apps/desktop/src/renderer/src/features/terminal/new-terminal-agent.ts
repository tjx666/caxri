import type {
    AgentAvailability,
    AppSettings,
    TerminalKind,
    TerminalRecord,
    TerminalSurface,
} from '@caxri/protocol';
import { canUseAgentChat, isChatTerminal, terminalKindSchema } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { getTerminalExitPresentation } from './terminal-exit-presentation';

/**
 * The value `session.defaultAgent` holds: an Agent, `shell`, or `null` when the user never named one.
 */
type ConfiguredDefaultAgent = AppSettings['session.defaultAgent'] | undefined;

/**
 * The value `session.openAgentsInChat` holds; `undefined` before settings load reads as off.
 */
type OpenAgentsInChat = AppSettings['session.openAgentsInChat'] | undefined;

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
    /**
     * True when the Agent's CLI could not be found. The row stays listed and selectable (the catalog is shared with the
     * phone, and a choice that vanishes cannot explain itself); it only gains the "Not installed" suffix and an install
     * hint.
     */
    isUnavailable: boolean;
    kind: TerminalKind;
    /**
     * What choosing this row creates: `chat` when the user opens Agents in Chat and this Agent supports it (ADR 0012).
     */
    surface: TerminalSurface;
}

/**
 * How a new Terminal or Session for `kind` opens. The surface is a preference rather than a separate menu entry per
 * Agent, so the menus list each Agent once and every creation path (menus, the split button, `⌘T`, a direct New
 * Session) agrees. An Agent without Chat support, and Shell, always open in a terminal.
 */
export function newAgentSurface(kind: TerminalKind, openInChat: OpenAgentsInChat): TerminalSurface {
    return openInChat === true && canUseAgentChat(kind) ? 'chat' : 'pty';
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
        // Only whether a presentation exists matters; the text is discarded, so the snapshot `translate` is fine.
        getTerminalExitPresentation(
            terminal.lastProcessState,
            undefined,
            undefined,
            undefined,
            translate,
        ) === undefined
    );
}

/**
 * A Terminal a click can create: which Agent, and whether it runs as a PTY or an Agent Chat.
 */
export interface NewTerminalTarget {
    kind: TerminalKind;
    surface: TerminalSurface;
}

/**
 * What a direct click on the tab-strip New Terminal `+` creates: the Agent the Session's primary Terminal is currently
 * running, on the same surface (a Chat clones as a Chat), so the new Terminal joins the same conversation instead of
 * always asking or always following a possibly stale configured default (Fix #1292).
 *
 * Falls through to the configured default Agent when the primary Terminal is a shell or has exited, and to `null` when
 * neither resolves: the button opens the Agent list rather than guessing.
 *
 * Deliberately not shared with {@link newTerminalCommandKind}: `⌘T`/`terminal.new` is a global shortcut with no
 * Session-scoped button to read a Primary Agent Terminal from at the call site, and dozens of E2E specs already rely on
 * it answering the configured default (or a shell) regardless of what a Session's other Terminals are doing; see
 * `pressNewTerminal` in `e2e/support/helpers.ts`. The button's tooltip shows `⌘T` only while both create the same
 * Terminal ({@link isSameNewTerminalTarget}): a shortcut chip beside a tooltip naming a different Agent would promise
 * something the shortcut does not do.
 */
export function resolveNewTerminalTarget(
    primaryTerminal: TerminalRecord | undefined,
    defaultAgent: ConfiguredDefaultAgent,
    openInChat: OpenAgentsInChat,
): NewTerminalTarget | null {
    if (primaryTerminal && isLiveAgentTerminal(primaryTerminal))
        return {
            kind: primaryTerminal.kind,
            surface: isChatTerminal(primaryTerminal) ? 'chat' : 'pty',
        };
    const kind = resolveNewTerminalAgent(defaultAgent);
    return kind ? { kind, surface: newAgentSurface(kind, openInChat) } : null;
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
 * What `terminal.new` (`⌘T`) creates, as a target the tab strip's `+` can compare with its own.
 */
export function newTerminalCommandTarget(
    defaultAgent: ConfiguredDefaultAgent,
    openInChat: OpenAgentsInChat,
): NewTerminalTarget {
    const kind = newTerminalCommandKind(defaultAgent);
    return { kind, surface: newAgentSurface(kind, openInChat) };
}

/**
 * Whether two New Terminal targets create the same Agent on the same surface.
 */
export function isSameNewTerminalTarget(
    left: NewTerminalTarget,
    right: NewTerminalTarget,
): boolean {
    return left.kind === right.kind && left.surface === right.surface;
}

const NO_UNAVAILABLE_AGENTS: ReadonlySet<TerminalKind> = new Set();

/**
 * The Agents whose CLI the Server could not find. An unanswered or failed availability query yields an empty set: the
 * menus then show no annotation rather than claiming an Agent is missing on no evidence.
 */
export function unavailableAgentKinds(
    availability: AgentAvailability | undefined,
): ReadonlySet<TerminalKind> {
    if (!availability) return NO_UNAVAILABLE_AGENTS;
    return new Set(
        availability.providers.filter((provider) => !provider.available).map(({ kind }) => kind),
    );
}

/**
 * The tooltip on an unavailable Agent row: where to get the CLI and where to tell Caxri about it. Shell is always
 * available, so it has no hint.
 */
export function agentInstallHint(kind: TerminalKind, t: Translate): string | undefined {
    switch (kind) {
        case 'claude':
            return t('terminal.new.installHint.claude');
        case 'codex':
            return t('terminal.new.installHint.codex');
        case 'grok':
            return t('terminal.new.installHint.grok');
        default:
            return undefined;
    }
}

/**
 * Every kind the split button's dropdown offers, in catalog order, with the configured default marked. Each Agent
 * appears once; `surface` says whether choosing it opens a Chat under the current preference. Nothing here depends on
 * what was picked last, so the list a user learns once stays where they learned it.
 */
export function newTerminalAgentChoices(
    defaultAgent: ConfiguredDefaultAgent,
    openInChat: OpenAgentsInChat,
    unavailable: ReadonlySet<TerminalKind> = NO_UNAVAILABLE_AGENTS,
): NewTerminalAgentChoice[] {
    const configured = resolveNewTerminalAgent(defaultAgent);
    return NEW_TERMINAL_KIND_CATALOG.map((kind) => ({
        isDefault: kind === configured,
        isUnavailable: unavailable.has(kind),
        kind,
        surface: newAgentSurface(kind, openInChat),
    }));
}

/**
 * What a New Terminal control says it will create, named by Agent and view ("New Codex Chat", "New Claude Code
 * Terminal") so the tab strip's `+` tooltip names the Agent its press starts (DESIGN.md, Tab strip). A Shell is plain
 * "New Terminal": it is not an Agent. `agentLabel` is the Agent's display name, resolved by the caller from the icon
 * registry so this module stays free of asset imports.
 */
export function newTerminalActionLabel(
    target: NewTerminalTarget,
    agentLabel: string,
    t: Translate,
): string {
    if (target.kind === 'shell') return t('terminal.new.terminal');
    return t(target.surface === 'chat' ? 'terminal.new.agentChat' : 'terminal.new.agentTerminal', {
        agent: agentLabel,
    });
}

/**
 * The empty pane's labelled button text: "New Chat" when its press opens an Agent Chat, "New Terminal" otherwise. The
 * leading Agent icon already names the Agent, so the text names only what kind of tab appears.
 */
export function newTerminalButtonText(surface: TerminalSurface | undefined, t: Translate): string {
    return t(surface === 'chat' ? 'terminal.new.chat' : 'terminal.new.terminal');
}

/**
 * What a New Session control with a default Agent says it will create ("New Codex Chat Session", "New Codex Session"),
 * named the way {@link newTerminalActionLabel} names a Terminal, so the Project heading's button and the tab strip's `+`
 * read alike. A Shell default is "New Shell Session".
 */
export function newSessionActionLabel(
    target: NewTerminalTarget,
    agentLabel: string,
    t: Translate,
): string {
    return t(
        target.surface === 'chat' ? 'terminal.new.agentChatSession' : 'terminal.new.agentSession',
        { agent: agentLabel },
    );
}

/**
 * The one muted suffix an Agent row in the New Session and New Terminal menus carries: `Not installed` when the CLI was
 * not found, `Chat` when choosing it opens a Chat, `Default` for the configured default Agent, those joined with `·`
 * when several apply, or nothing. One suffix rather than two separate markers, so both menus mark a row the same way
 * and the words stay text a screen reader reads.
 */
export function agentChoiceMarker(
    choice: Pick<NewTerminalAgentChoice, 'isDefault' | 'surface'> & { isUnavailable?: boolean },
    t: Translate,
): string | undefined {
    const parts = [
        choice.isUnavailable === true && t('terminal.new.notInstalledMarker'),
        choice.surface === 'chat' && t('terminal.new.chatMarker'),
        choice.isDefault && t('terminal.new.defaultMarker'),
    ].filter((part): part is string => typeof part === 'string');
    return parts.length > 0 ? parts.join(' · ') : undefined;
}

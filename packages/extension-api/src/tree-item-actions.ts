/**
 * Tree item hover-card and inline-action contracts, re-exported from the `caxri` entry module.
 */
import type { ThemeIcon } from './index.js';

export interface Command {
    command: string;
    title: string;
    arguments?: readonly unknown[];
}

export type TreeItemTooltipTone = 'neutral' | 'success' | 'warning' | 'danger';

export interface TreeItemTooltipRow {
    label: string;
    value: string;
    /**
     * HTTP(S) destination opened through Caxri's trusted-origin policy.
     */
    url?: string;
}

/**
 * Bounded interactive content for a TreeItem hover card. Text is rendered literally (`markdown` through a closed,
 * HTML-free subset) and URLs are validated by the Extension Host before reaching the Renderer, so extensions cannot
 * inject HTML, scripts, or command links.
 */
export interface TreeItemRichTooltip {
    kind: 'rich';
    title: string;
    /**
     * Prose that explains the title, such as a provider error's recovery hint. Structured facts belong in `rows`.
     */
    description?: string;
    /**
     * Markdown body for authored prose such as a pull request review comment; takes the place of `description`. The
     * Renderer shows a closed subset (paragraphs, lists, quotes, code, emphasis, HTTP(S) links) as text nodes. Raw HTML
     * is dropped and images collapse to their alt text, so this does not widen what an extension can inject.
     */
    markdown?: string;
    badge?: { label: string; tone: TreeItemTooltipTone };
    /**
     * Omitted or empty when the title and badge already carry the whole hover, so a row without structured facts keeps
     * the same card instead of falling back to a plain-text tooltip.
     */
    rows?: readonly TreeItemTooltipRow[];
}

/**
 * Asks the user before an inline action runs. The copy contract mirrors the Workbench confirmation modal: `title` asks
 * the question, `message` states what confirming changes and how reversible it is, and `confirmLabel` names the
 * action.
 */
export interface TreeItemActionConfirmation {
    title: string;
    message: string;
    confirmLabel: string;
}

/**
 * What the Workbench tells the user after an inline action's command settles. Commands cannot raise notifications
 * themselves, so the action declares the copy up front and the Workbench shows it once the command resolves or
 * rejects.
 */
export interface TreeItemActionFeedback {
    /**
     * Success toast text, such as `Merged #123`.
     */
    success?: string;
    /**
     * Failure toast prefix. The Workbench appends the command's own reason: `Couldn't merge #123: <reason>`.
     */
    failure?: string;
    /**
     * GitHub page both toasts offer through an `Open on GitHub` button. Must be a credential-free HTTP(S) URL.
     */
    githubUrl?: string;
}

/**
 * Semantic color of a labeled inline action, mapped to the theme's status tokens.
 */
export type TreeItemActionTone = 'neutral' | 'success' | 'warning' | 'danger';

/**
 * A command shown as an icon button at the end of its row while the row is hovered or focused, like VS Code's inline
 * `view/item/context` actions. `command.title` is the button's accessible name and, unless `tooltip` is set, its
 * tooltip. Besides an extension command, `command.command` may be one of two Workbench commands the Renderer resolves
 * without a round trip to the extension: `caxri.openExternal` with a URL argument opens the page in the browser, and
 * `caxri.sendToAgent` with a prompt string argument sends it to the selected Session's Agent (a Chat message, or one
 * submitted paste for a Terminal Agent) and reveals that Agent. Control characters other than newlines and tabs are
 * stripped from the prompt.
 */
export interface TreeItemAction {
    command: Command;
    icon: ThemeIcon;
    /**
     * Short visible text. A labeled action is the row's primary call to action: it renders as a text button and stays
     * visible at rest instead of revealing on hover.
     */
    label?: string;
    /**
     * Color of the action, which keeps it visible at rest: a colored text button with `label`, else a colored icon.
     */
    tone?: TreeItemActionTone;
    /**
     * Set when this occurrence of the action needs a second look before it runs. The Workbench shows the question and
     * only dispatches the command once the user confirms.
     */
    confirmation?: TreeItemActionConfirmation;
    /**
     * Why the action is in its current state, such as `Checks still running`. Shown in the button's tooltip on hover
     * and keyboard focus and spoken as its accessible description, so `command.title` can stay the plain action name.
     */
    tooltip?: string;
    feedback?: TreeItemActionFeedback;
}

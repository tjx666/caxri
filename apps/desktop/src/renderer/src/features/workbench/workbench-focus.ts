import { getTerminalFocusElement } from '../terminal/terminal-pane-handlers';
import { getActivePaneTab } from './pane-actions';

/**
 * The element a closing picker should focus when nothing better is known: the active pane's Terminal, which is what the
 * user was working in before reaching for `Cmd+P`. Editors keep Base UI's default because Monaco restores its own
 * focus, and a pane without a Terminal yields nothing rather than a guess.
 */
export function activeWorkbenchFocusElement(): HTMLElement | null {
    const resource = getActivePaneTab()?.resource;
    return resource?.kind === 'terminal' ? getTerminalFocusElement(resource.terminalId) : null;
}

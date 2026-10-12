import { translate } from '../../i18n';

/**
 * The words a detected Terminal link shows: the hover hint and the fallback accessible name. Kept beside the link
 * detector rather than inside it so the detector stays focused on parsing; both are translated when a link is provided,
 * so they follow the active language.
 */
export function terminalLinkHintText(match: {
    hint?: string;
    kind: 'commit' | 'file' | 'url';
}): string {
    if (match.hint) return match.hint;
    return translate(
        match.kind === 'url'
            ? 'terminal.links.hint.openInBrowser'
            : match.kind === 'commit'
              ? 'terminal.links.hint.showCommit'
              : 'terminal.links.hint.openInEditor',
    );
}

export function terminalLinkAccessibleName(
    kind: 'commit' | 'file' | 'url',
    target: string,
): string {
    return translate(
        kind === 'url' ? 'terminal.links.openExternalLink' : 'terminal.links.openFileLink',
        { target },
    );
}

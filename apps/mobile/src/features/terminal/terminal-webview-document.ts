import { terminalWebviewHtml } from './terminal-webview.generated';

/**
 * The only runtime substitution in the bundled offline document is the validated Terminal identity.
 */
export const terminalWebviewDocument = (terminalId: string): string => {
    if (!/^[\w-]{1,200}$/u.test(terminalId)) throw new Error('Invalid Terminal identity');
    return terminalWebviewHtml.split('__TERMINAL_ID_JSON__').join(JSON.stringify(terminalId));
};

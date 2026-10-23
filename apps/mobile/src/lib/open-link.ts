import { router } from 'expo-router';

import { linkTarget } from '../features/browser/browser-url';
import { openExternalLink } from './open-external-link';

/**
 * Opens a link the way the reader expects in Caxri: a web page in the in-app browser, which slides over the current
 * screen and returns to the same place when closed, and any other scheme in the app the system assigns. Every link the
 * phone renders goes through here so the two never diverge. `navigate` and `openExternal` exist for tests.
 */
export const openLink = (
    url: string,
    {
        navigate = (target: string) =>
            router.push({ params: { url: target }, pathname: '/browser' }),
        openExternal = openExternalLink,
    }: {
        navigate?: (target: string) => void;
        openExternal?: (target: string) => Promise<void>;
    } = {},
): void => {
    if (linkTarget(url) === 'inApp') {
        navigate(url);
        return;
    }
    void openExternal(url);
};

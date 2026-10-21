import { createElement } from 'react';
import { createRoot } from 'react-dom/client';

import { QueryClientProvider } from '@tanstack/react-query';

import { LinkFavicon } from '../../../components/markdown/link-favicon';
import { linkSummary } from '../../../lib/link-summary';
import { queryClient } from '../../../queries/client';
import type { AgentChatLinkIconMount } from './agent-chat-composer-extensions';

/**
 * The composer's link icon mount (`agentChatLinkIcons`): each link's slot gets its own React root rendering the
 * transcript's `LinkFavicon`, so a pasted pull request link shows the same state glyph and reads the same cached
 * reference preview as it will once sent. CodeMirror owns the slot's lifetime, so the root is separate from the
 * composer's tree and brings its own query provider.
 */
export function agentChatComposerLinkIconMount(
    referenceTerminalId: string | undefined,
): AgentChatLinkIconMount {
    return (slot, url) => {
        const summary = linkSummary(url);
        if (!summary) return () => {};
        const root = createRoot(slot);
        const icon = createElement(LinkFavicon, {
            origin: new URL(url).origin,
            referenceTerminalId,
            summary,
        });
        root.render(createElement(QueryClientProvider, { client: queryClient }, icon));
        // CodeMirror destroys widgets inside a dispatch, which can run during a React commit (the draft effect); an
        // unmount there would be synchronous inside React's own work, so it waits for the next microtask.
        return () => queueMicrotask(() => root.unmount());
    };
}

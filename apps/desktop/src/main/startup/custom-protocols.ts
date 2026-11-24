import { app, protocol } from 'electron';

import {
    AGENT_CHAT_MEDIA_PRIVILEGED_SCHEME,
    attachAgentChatMediaProtocol,
} from '../agent-chat/media-protocol';
import {
    attachHtmlPreviewProtocol,
    HTML_PREVIEW_PRIVILEGED_SCHEME,
} from '../html-preview/protocol';

/**
 * Registers every custom scheme Main serves to the Renderer. Electron accepts privileged schemes only before `ready`
 * and only in one `registerSchemesAsPrivileged` call (a second call replaces the first), so Main's entry calls this
 * once at module scope with all of them; the handlers attach once the app is ready.
 */
export function installCustomProtocols(): void {
    protocol.registerSchemesAsPrivileged([
        AGENT_CHAT_MEDIA_PRIVILEGED_SCHEME,
        HTML_PREVIEW_PRIVILEGED_SCHEME,
    ]);
    void app.whenReady().then(() => {
        attachAgentChatMediaProtocol();
        attachHtmlPreviewProtocol();
    });
}

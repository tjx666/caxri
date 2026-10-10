import type { TerminalKind } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

/**
 * The name the phone shows for a Terminal kind, read from the shared provider catalog so it always matches Desktop
 * (`Grok Build`, not `Grok`). A caller with no kind picks the fallback its own copy needs.
 */
export const mobileAgentDisplayName = (kind: TerminalKind): string =>
    kind === 'shell' ? 'Shell' : agentProviderCatalog[kind].displayName;

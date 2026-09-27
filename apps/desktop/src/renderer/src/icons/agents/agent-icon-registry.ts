import type { AgentProvider, TerminalKind } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import claudeCodeMono from '@lobehub/icons-static-svg/icons/claudecode.svg?no-inline';
import claudeCodeColor from '@lobehub/icons-static-svg/icons/claudecode-color.svg?no-inline';
import codexMono from '@lobehub/icons-static-svg/icons/codex.svg?no-inline';
import codexColor from '@lobehub/icons-static-svg/icons/codex-color.svg?no-inline';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?no-inline';
import openCode from '@lobehub/icons-static-svg/icons/opencode.svg?no-inline';

export type AgentIconIdentity = TerminalKind | 'opencode' | 'unknown';

/**
 * Which rendering `AgentIdentityIcon` should resolve to (see {@link resolveAgentIconRenderSource}):
 *
 * - `'brand'` (the default) keeps a `color-asset` identity's full-color mark — pickers and menus that identify an Agent
 *   brand without tinting it by any live state (Settings, Create Session, the New Terminal menu, Agent Actions).
 * - `'state'` renders every identity through the `bg-current` mask, including `color-asset` ones, so it tints with
 *   `currentColor` exactly like `mask-asset` identities already do. Use this in a context that colors the icon by the
 *   Session/Terminal's own running/waiting/idle/failed state or its tab/row selection state (Session rows, Activity
 *   rows, Terminal tab icons).
 */
export type AgentIconTone = 'brand' | 'state';

export interface AgentIconDefinition {
    id: AgentIconIdentity;
    label: string;
    kind: 'color-asset' | 'mask-asset' | 'shell' | 'unknown';
    src?: string;
    /**
     * Present only for `color-asset` identities: the plain, non-gradient `fill="currentColor"` export
     * `@lobehub/icons-static-svg` ships alongside the brand-color one. This is what `tone: 'state'` resolves to instead
     * of `src`.
     */
    monoSrc?: string;
}

const managedAgentIconAssets: Record<
    AgentProvider,
    Pick<AgentIconDefinition, 'kind' | 'monoSrc' | 'src'>
> = {
    claude: { kind: 'color-asset', monoSrc: claudeCodeMono, src: claudeCodeColor },
    codex: { kind: 'color-asset', monoSrc: codexMono, src: codexColor },
    grok: { kind: 'mask-asset', src: grok },
};

const managedAgentIcons = Object.fromEntries(
    agentProviderIds.map((provider) => [
        provider,
        {
            id: provider,
            label: agentProviderCatalog[provider].displayName,
            ...managedAgentIconAssets[provider],
        },
    ]),
) as Record<AgentProvider, AgentIconDefinition>;

export const agentIconRegistry = {
    ...managedAgentIcons,
    opencode: { id: 'opencode', kind: 'mask-asset', label: 'OpenCode', src: openCode },
    shell: { id: 'shell', kind: 'shell', label: 'Shell' },
    unknown: { id: 'unknown', kind: 'unknown', label: 'Unknown Agent' },
} satisfies Record<AgentIconIdentity, AgentIconDefinition>;

export function resolveAgentIcon(identity?: string | null): AgentIconDefinition {
    return identity && Object.hasOwn(agentIconRegistry, identity)
        ? agentIconRegistry[identity as AgentIconIdentity]
        : agentIconRegistry.unknown;
}

/**
 * What `AgentIdentityIcon` actually draws for a resolved icon and tone. Pure and Vitest-covered on its own so the
 * branching that used to sit directly in the `.tsx` (untestable per `source-layout`) has a narrow, unit-testable seam.
 *
 * `shell` and `unknown` render their own lucide glyph directly (already `currentColor`, tone-agnostic) and never reach
 * here — the caller checks `icon.kind` for those first.
 */
export function resolveAgentIconRenderSource(
    icon: AgentIconDefinition,
    tone: AgentIconTone = 'brand',
): { kind: 'image' | 'mask'; src: string } | undefined {
    if (icon.kind === 'shell' || icon.kind === 'unknown') return undefined;
    if (tone === 'brand' && icon.kind === 'color-asset')
        return icon.src ? { kind: 'image', src: icon.src } : undefined;
    // `tone: 'state'` on a color-asset identity resolves to its mono mask; a mask-asset identity
    // already has nothing but its mask `src`, regardless of tone.
    const maskSource = icon.kind === 'color-asset' ? icon.monoSrc : icon.src;
    return maskSource ? { kind: 'mask', src: maskSource } : undefined;
}

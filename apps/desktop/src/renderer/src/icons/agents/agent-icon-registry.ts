import type { AgentProvider, TerminalKind } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import antigravityColor from '@lobehub/icons-static-svg/icons/antigravity-color.svg?no-inline';
import claudeCodeColor from '@lobehub/icons-static-svg/icons/claudecode-color.svg?no-inline';
import codexColor from '@lobehub/icons-static-svg/icons/codex-color.svg?no-inline';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?no-inline';
import openCode from '@lobehub/icons-static-svg/icons/opencode.svg?no-inline';

import { translate } from '../../i18n';

export type AgentIconIdentity = TerminalKind | 'opencode' | 'unknown';

export interface AgentIconDefinition {
    id: AgentIconIdentity;
    label: string;
    kind: 'color-asset' | 'mask-asset' | 'shell' | 'unknown';
    src?: string;
    /**
     * Fraction of the requested box the mark is drawn at, for a mark whose ink fills its viewBox far more than its
     * siblings'. Codex's mark is a full 24×24 circle (its color export a full 24×24 tile), while Claude Code's glyph
     * spans only 24×15 of the same viewBox, so at one `size` Codex read visibly larger. The outer box keeps `size` so
     * rows stay aligned; only the drawn mark shrinks. Omitted means `1`.
     */
    opticalScale?: number;
}

const managedAgentIconAssets: Record<
    AgentProvider,
    Pick<AgentIconDefinition, 'kind' | 'opticalScale' | 'src'>
> = {
    claude: { kind: 'color-asset', src: claudeCodeColor },
    codex: { kind: 'color-asset', opticalScale: 0.8, src: codexColor },
    grok: { kind: 'mask-asset', src: grok },
    antigravity: { kind: 'color-asset', src: antigravityColor },
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
    unknown: {
        id: 'unknown',
        kind: 'unknown',
        /**
         * A getter so the fallback name follows the interface language at the moment a surface reads it. Every other
         * label is a product name that stays the same in both languages.
         */
        get label() {
            return translate('core.agentIcon.unknown');
        },
    },
} satisfies Record<AgentIconIdentity, AgentIconDefinition>;

export function resolveAgentIcon(identity?: string | null): AgentIconDefinition {
    return identity && Object.hasOwn(agentIconRegistry, identity)
        ? agentIconRegistry[identity as AgentIconIdentity]
        : agentIconRegistry.unknown;
}

/**
 * What `AgentIdentityIcon` actually draws for a resolved icon: a `color-asset` identity keeps its full-color mark, and
 * a `mask-asset` one tints with `currentColor`. Pure and Vitest-covered on its own so the branching stays out of the
 * `.tsx` (untestable per `source-layout`).
 *
 * `shell` and `unknown` render their own lucide glyph directly and never reach here: the caller checks `icon.kind` for
 * those first.
 */
export function resolveAgentIconRenderSource(
    icon: AgentIconDefinition,
): { kind: 'image' | 'mask'; src: string } | undefined {
    if (icon.kind === 'shell' || icon.kind === 'unknown' || !icon.src) return undefined;
    return { kind: icon.kind === 'color-asset' ? 'image' : 'mask', src: icon.src };
}

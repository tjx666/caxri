import type { AgentProvider, TerminalKind } from '@caxri/protocol';
import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import antigravityColor from '@lobehub/icons-static-svg/icons/antigravity-color.svg?no-inline';
import claudeCodeColor from '@lobehub/icons-static-svg/icons/claudecode-color.svg?no-inline';
import grok from '@lobehub/icons-static-svg/icons/grok.svg?no-inline';
import openCode from '@lobehub/icons-static-svg/icons/opencode.svg?no-inline';

import { translate } from '../../i18n';
/**
 * `@lobehub/icons-static-svg`'s `codex-color.svg` with its white app-tile backdrop removed, so the gradient mark sits
 * on the surface like the other Agent marks instead of as a white square on dark themes. The mark spans only 18 of the
 * upstream 24 viewBox units, so the viewBox is tightened to `2 2 20 20` to match its sibling glyphs' visual size.
 */
import codexColor from './codex-color.svg?no-inline';

export type AgentIconIdentity = TerminalKind | 'opencode' | 'unknown';

export interface AgentIconDefinition {
    id: AgentIconIdentity;
    label: string;
    kind: 'color-asset' | 'mask-asset' | 'shell' | 'unknown';
    src?: string;
}

const managedAgentIconAssets: Record<AgentProvider, Pick<AgentIconDefinition, 'kind' | 'src'>> = {
    claude: { kind: 'color-asset', src: claudeCodeColor },
    codex: { kind: 'color-asset', src: codexColor },
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

/**
 * Classifies a changed-file set into the ownership layers `check.ts` reports, and the follow-up gates a dirty-layer
 * combination should run, without executing any of them. Split out of `check.ts` to keep that file under its own
 * source-size ratchet: this is a self-contained "what does this diff affect" concern, independent of how any gate is
 * actually run.
 */
import { extname } from 'node:path';

/**
 * Type-aware linting (oxlint + tsgolint) only understands files that belong to a TypeScript program; plain JS files
 * stay on the syntactic ESLint pipeline alone.
 */
export const TYPE_AWARE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

export type DirtyLayer =
    | 'Renderer'
    | 'Main'
    | 'Preload'
    | 'Server Core'
    | 'Domains'
    | 'Server'
    | 'Mobile'
    | 'System'
    | 'IPC'
    | 'Shared'
    | 'Mobile Transport'
    | 'CLI'
    | 'e2e'
    | 'skills'
    | 'tooling'
    | 'docs'
    | 'other';

export interface DirtyLayerReport {
    layers: DirtyLayer[];
    suggestedGates: string[];
}

const PROTECTED_E2E_GATES = new Map([
    ['e2e/real-agent-smoke.e2e.ts', 'bun run test:e2e:real-agent'],
    ['e2e/failure-isolation.e2e.ts', 'bun run scripts/run-e2e-failure-isolation.ts'],
]);

const DIRTY_LAYER_ORDER: DirtyLayer[] = [
    'Renderer',
    'Main',
    'Preload',
    'Server Core',
    'Domains',
    'Server',
    'Mobile',
    'System',
    'IPC',
    'Shared',
    'Mobile Transport',
    'CLI',
    'e2e',
    'skills',
    'tooling',
    'docs',
    'other',
];

function dirtyLayerForFile(file: string): DirtyLayer {
    const normalized = file.replaceAll('\\', '/');
    if (normalized.startsWith('apps/desktop/src/renderer/')) return 'Renderer';
    if (normalized.startsWith('apps/desktop/src/main/')) return 'Main';
    if (normalized.startsWith('apps/desktop/src/preload/')) return 'Preload';
    if (normalized.startsWith('apps/server/src/core/')) return 'Server Core';
    if (normalized.startsWith('apps/server/src/domains/')) return 'Domains';
    if (normalized.startsWith('apps/server/')) return 'Server';
    if (normalized.startsWith('apps/mobile/')) return 'Mobile';
    if (normalized.startsWith('apps/cli/')) return 'CLI';
    if (normalized.startsWith('packages/system/')) return 'System';
    if (normalized.startsWith('packages/protocol/')) return 'IPC';
    if (normalized.startsWith('packages/utils/')) return 'Shared';
    if (normalized.startsWith('packages/mobile-transport/')) return 'Mobile Transport';
    if (
        normalized.startsWith('packages/agent-skills/') ||
        normalized.startsWith('packages/client/') ||
        normalized.startsWith('packages/extension-api/')
    )
        return 'Shared';
    if (normalized.startsWith('e2e/')) return 'e2e';
    if (normalized.startsWith('.agents/skills/')) return 'skills';
    if (
        normalized.startsWith('.github/') ||
        normalized.startsWith('build/') ||
        normalized.startsWith('scripts/')
    )
        return 'tooling';
    if (normalized.startsWith('docs/') || extname(normalized).toLowerCase() === '.md')
        return 'docs';
    return 'other';
}

/**
 * Reports affected ownership layers and follow-up gates without executing the suggested gates.
 */
export function dirtyLayerReportForFiles(
    files: string[],
    hasExplicitFiles: boolean,
): DirtyLayerReport {
    const dirtyLayers = new Set(files.map(dirtyLayerForFile));
    const layers = DIRTY_LAYER_ORDER.filter((layer) => dirtyLayers.has(layer));
    const suggestedGates: string[] = [];
    /**
     * React Doctor is not limited to the Renderer. CI runs it over every changed TypeScript file, and rules such as
     * `js-combine-iterations` are plain JavaScript performance rules that a Server-only change trips just as easily.
     * Routing this gate by layer let a Domains change pass the focused check and then stop full platform checks, the
     * one outcome this check exists to prevent.
     */
    if (files.some((file) => TYPE_AWARE_EXTENSIONS.has(extname(file))))
        suggestedGates.push('bun run doctor:changed');
    if (
        dirtyLayers.has('Renderer') ||
        dirtyLayers.has('IPC') ||
        dirtyLayers.has('Shared') ||
        dirtyLayers.has('System') ||
        dirtyLayers.has('Mobile') ||
        dirtyLayers.has('Mobile Transport')
    )
        suggestedGates.push('bun run knip');
    if (hasExplicitFiles) {
        const e2eSpecs = files.filter((file) => /^e2e\/.+\.e2e\.ts$/.test(file));
        if (e2eSpecs.some((file) => !PROTECTED_E2E_GATES.has(file))) suggestedGates.push('--e2e');
        for (const [file, gate] of PROTECTED_E2E_GATES) {
            if (e2eSpecs.includes(file)) suggestedGates.push(gate);
        }
    }
    return { layers, suggestedGates };
}

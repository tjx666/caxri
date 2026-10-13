import { Buffer } from 'node:buffer';

import type { Plugin } from 'vite';

/**
 * Most JavaScript each lightweight host may load before it serves: its entry chunk plus every chunk it imports
 * statically, transitively. V8 keeps every loaded module's source text resident and compiles what runs, so bytes here
 * turn into host memory one for one or worse. Rolldown keeps every top-level schema call of a module it includes and
 * groups shared code by the set of entries that reach it, so one host import of a symbol defined in a schema-heavy
 * protocol module, or of a Server Core module, drags a whole shared chunk into the host. Measured when the budget was
 * set: Terminal Host 516 KiB, Extension Host 270 KiB (both were 819 KiB and 426 KiB before the protocol leaf modules).
 * See `docs/server-footprint.md`.
 */
const HOST_STARTUP_BUDGETS: Readonly<Record<string, number>> = {
    'extension-host': 320 * 1024,
    'terminal-host': 600 * 1024,
};

/**
 * The part of a Rolldown output chunk the budget reads; an `OutputBundle` satisfies it.
 */
export type StartupBundle = Readonly<
    Record<string, { code: string; imports: readonly string[]; type: 'chunk' } | { type: 'asset' }>
>;

export interface StartupJavaScript {
    bytes: number;
    /**
     * Every chunk the entry loads at startup with its size, largest first.
     */
    chunks: Array<{ bytes: number; fileName: string }>;
}

export function measureStartupJavaScript(
    bundle: StartupBundle,
    entryFileName: string,
): StartupJavaScript {
    const chunks: StartupJavaScript['chunks'] = [];
    const pending = [entryFileName];
    const visited = new Set<string>();
    for (let fileName = pending.pop(); fileName !== undefined; fileName = pending.pop()) {
        if (visited.has(fileName)) continue;
        visited.add(fileName);
        const chunk = Object.hasOwn(bundle, fileName) ? bundle[fileName] : undefined;
        if (chunk?.type !== 'chunk') throw new Error(`${fileName} is not a chunk of this bundle`);
        chunks.push({ bytes: Buffer.byteLength(chunk.code), fileName });
        pending.push(...chunk.imports.filter((id) => id in bundle));
    }
    chunks.sort((left, right) => right.bytes - left.bytes);
    return { bytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0), chunks };
}

const formatKiB = (bytes: number): string => `${Math.round(bytes / 1024)} KiB`;

/**
 * Fails the build when a host entry's startup JavaScript exceeds its budget in {@link HOST_STARTUP_BUDGETS}, naming the
 * chunks it loads so the import that pulled in a shared chunk is quick to find.
 */
export function hostStartupBudget(budgets = HOST_STARTUP_BUDGETS): Plugin {
    return {
        name: 'caxri-host-startup-budget',
        generateBundle(_options, bundle) {
            for (const [entry, budget] of Object.entries(budgets)) {
                const startup = measureStartupJavaScript(bundle, `${entry}.js`);
                if (startup.bytes <= budget) continue;
                const chunks = startup.chunks
                    .map((chunk) => `${chunk.fileName} ${formatKiB(chunk.bytes)}`)
                    .join(', ');
                throw new Error(
                    `${entry} loads ${formatKiB(startup.bytes)} of JavaScript at startup, over its ${formatKiB(budget)} budget (${chunks}). A host probably imports a symbol defined in a schema-heavy protocol module, or a Server Core module; see docs/server-footprint.md`,
                );
            }
        },
    };
}

import { extname } from 'node:path';

import type { Rule } from 'eslint';

const typeScriptExtensions = new Set(['.cts', '.mts', '.ts', '.tsx']);

/**
 * Port of `@yutengjing/no-declare-implicit-any-var` without its Vue branch. Upstream probes four Vue packages through
 * `local-pkg` inside `create`, uncached, once per linted file: that probe alone was about 46% of hosted ESLint time.
 * Caxri has no Vue, so the TypeScript checks are kept verbatim and the probe is dropped.
 */
const rule: Rule.RuleModule = {
    meta: {
        type: 'suggestion',
        schema: [],
        messages: {
            default: "don't declare variable without type",
        },
    },
    create(context) {
        if (!typeScriptExtensions.has(extname(context.filename).toLowerCase())) return {};
        return {
            VariableDeclaration(node) {
                // `for (let item of items)` takes its type from the iterable.
                if (node.parent.type === 'ForOfStatement' || node.parent.type === 'ForInStatement')
                    return;
                if (node.kind !== 'const' && node.kind !== 'let') return;
                for (const declarator of node.declarations) {
                    const { init } = declarator;
                    const hasTypeAnnotation =
                        'typeAnnotation' in declarator.id && declarator.id.typeAnnotation != null;
                    if (
                        !hasTypeAnnotation &&
                        (init == null ||
                            (init.type === 'ArrayExpression' && init.elements.length === 0))
                    ) {
                        context.report({ node: declarator, messageId: 'default' });
                    }
                }
            },
        };
    },
};

export default rule;

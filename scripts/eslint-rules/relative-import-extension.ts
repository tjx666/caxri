import type { Rule } from 'eslint';
import type { Node } from 'estree';

const relativeSpecifier = /^\.{1,2}(?:\/|$)/u;

/**
 * Workspace packages emit `dist` with `tsc`, which keeps each specifier as written, and Node's ESM loader resolves a
 * relative specifier only with its extension. An extensionless `./read-file-handle-up-to` passed every local check and
 * failed only in the hosted `bundle budget` job, whose `verify-exports.ts` loads `@caxri/system`'s dist under Node.
 * Requires `.js` on every relative import, re-export, and literal dynamic import.
 */
const rule: Rule.RuleModule = {
    meta: {
        type: 'problem',
        schema: [],
        messages: {
            missingExtension:
                "Relative specifier '{{specifier}}' needs a '.js' extension: Node ESM cannot resolve the emitted dist without it.",
        },
    },
    create(context) {
        const check = (source: Node | null | undefined) => {
            if (source?.type !== 'Literal' || typeof source.value !== 'string') return;
            if (!relativeSpecifier.test(source.value) || source.value.endsWith('.js')) return;
            context.report({
                node: source,
                messageId: 'missingExtension',
                data: { specifier: source.value },
            });
        };
        return {
            ExportAllDeclaration: (node) => check(node.source),
            ExportNamedDeclaration: (node) => check(node.source),
            ImportDeclaration: (node) => check(node.source),
            ImportExpression: (node) => check(node.source),
        };
    },
};

export default rule;

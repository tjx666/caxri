import type { Rule } from 'eslint';
import type { CallExpression, Node } from 'estree';

/**
 * Property keys whose function body is a cache-managed request. A read issued from one of these is already owned by
 * React Query: its result is keyed, deduplicated, invalidated, and garbage-collected with every other server read.
 */
const cacheManagedFunctionKeys = new Set(['queryFn', 'mutationFn']);

/**
 * Modules whose job is to speak to the Server on behalf of the cache and command layers (`view-operation-client.ts`,
 * `extension-tree-client.ts`, `view-container-commands.ts`, ...). The RPC has to live somewhere; naming the layer that
 * owns it is what keeps the call out of the components and hooks whose state cannot survive a remount.
 */
const dataAccessFilePattern = /(?:^|\/)[\w.-]*-(?:client|commands)\.ts$/u;

/**
 * Both ways the bridge issues a request. `requestWithSignal` is the abortable form (`resource-explorer-client.ts` uses
 * it for search), and it loses state on a remount exactly like `request` does.
 */
const requestMethodNames = new Set(['request', 'requestWithSignal']);

function isCaxriRequestCall(node: CallExpression): boolean {
    const callee = node.callee;
    return (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.object.type === 'Identifier' &&
        callee.object.name === 'caxri' &&
        callee.property.type === 'Identifier' &&
        requestMethodNames.has(callee.property.name)
    );
}

function requestedMethodName(node: CallExpression): string | undefined {
    // `.at(0)` (not `[0]`) keeps the result typed as possibly missing: a bare `caxri.request()` has no method argument.
    const method = node.arguments.at(0);
    return method?.type === 'Literal' && typeof method.value === 'string'
        ? method.value
        : undefined;
}

function propertyKeyName(node: Node): string | undefined {
    if (node.type !== 'Property' || node.computed) return undefined;
    if (node.key.type === 'Identifier') return node.key.name;
    return node.key.type === 'Literal' && typeof node.key.value === 'string'
        ? node.key.value
        : undefined;
}

function isCacheManagedRequest(ancestors: readonly Node[]): boolean {
    return ancestors.some((ancestor) => {
        const key = propertyKeyName(ancestor);
        return key !== undefined && cacheManagedFunctionKeys.has(key);
    });
}

/**
 * Keeps View Container server state inside the React Query cache.
 *
 * A read that resolves into component state dies with the component. The Extension Tree learned this the expensive way:
 * its view is keyed by Session, so switching Sessions discarded every loaded branch and the panel rebuilt itself from
 * an empty state (#791). The convention already existed in `.agents/skills/react/SKILL.md` section 4 ("components never
 * call `caxri.request` for reads"), but nothing enforced it, so the one view that skipped the cache was
 * indistinguishable from the views that did not.
 *
 * The rule deliberately matches every `caxri.request` rather than only read-effect methods: the protocol registry that
 * classifies them cannot be imported here (ESLint loads this rule through jiti, which resolves workspace packages to a
 * `dist/` build a fresh checkout has not produced), and "the RPC lives in the client or commands layer" is the boundary
 * worth enforcing either way.
 */
const serverReadsThroughQuery: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Require View Container server requests to go through the query, client, or commands layer instead of component state.',
        },
        schema: [],
        messages: {
            requestOutsideDataLayer:
                "Call '{{method}}' from a queryFn, a mutationFn, a *-client.ts module, or a *-commands.ts module. Server state resolved into component state is lost whenever the view remounts; see .agents/skills/react/SKILL.md section 4.",
        },
    },
    create(context) {
        if (dataAccessFilePattern.test(context.filename.replaceAll('\\', '/'))) return {};
        return {
            CallExpression(node) {
                if (!isCaxriRequestCall(node)) return;
                if (isCacheManagedRequest(context.sourceCode.getAncestors(node))) return;
                context.report({
                    node,
                    messageId: 'requestOutsideDataLayer',
                    data: { method: requestedMethodName(node) ?? 'caxri.request' },
                });
            },
        };
    },
};

export default serverReadsThroughQuery;

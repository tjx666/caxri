import type { Rule } from 'eslint';
import type { Expression, Node, Statement } from 'estree';

const nameLooksLikeFanout = /listener|subscriber|handler/iu;
/**
 * Names a teardown callback reads under when a cleanup fan-out invokes it bare: `for (const dispose of removers)
 * dispose();`.
 */
const nameLooksLikeDisposer = /dispos|unsubscribe|remov|cleanup|teardown/iu;

/**
 * Reduces a for-of/forEach body to the one statement it must be to match the bug this rule targets: `for (const
 * listener of listeners) listener(value);`, with or without braces. A body with more than one statement, or none, is
 * exactly the shape an isolating rewrite produces (a `try`/`catch`, or a call through the shared `notifyListeners`
 * helper instead), so it is never a candidate.
 */
function soleExpression(body: Statement): Expression | undefined {
    const statement =
        body.type === 'BlockStatement' ? (body.body.length === 1 ? body.body[0] : undefined) : body;
    return statement?.type === 'ExpressionStatement' ? statement.expression : undefined;
}

/**
 * Strips the `ChainExpression` wrapper ESTree puts around `listener?.()` and `listener?.dispose()`, so an optional call
 * matches the same as a plain one.
 */
function unwrapChain(expression: Expression): Expression {
    return expression.type === 'ChainExpression' ? expression.expression : expression;
}

/**
 * True when `expression` is nothing but `<name>(...)`: the loop or callback parameter invoked directly as a function. A
 * method call on the parameter (`listener.dispose()`) has a member callee instead of a bare identifier, so this does
 * not match cleanup fan-outs; {@link isBareDisposeOf} covers those.
 */
function isBareCallOf(expression: Expression, name: string): boolean {
    const call = unwrapChain(expression);
    return (
        call.type === 'CallExpression' &&
        call.callee.type === 'Identifier' &&
        call.callee.name === name
    );
}

/**
 * True when `expression` is nothing but `<name>.dispose()` (or `<name>?.dispose()`): the cleanup fan-out shape. A loop
 * of these stops at the first throwing `dispose()` and leaks every later subscription, so it must go through
 * `@caxri/utils`'s `disposeAll` / `disposeAllThenRethrow` instead (caxri#1462). A single `dispose()` call outside a
 * loop is never passed here, so it is never flagged.
 */
function isBareDisposeOf(expression: Expression, name: string): boolean {
    const call = unwrapChain(expression);
    if (call.type !== 'CallExpression') return false;
    const callee = call.callee;
    return (
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'dispose' &&
        callee.object.type === 'Identifier' &&
        callee.object.name === name
    );
}

/**
 * True when `expression` releases the loop or callback binding `name` without isolation: either `<name>.dispose()`, or
 * a bare `<name>()` where either `name` or the collection it came from reads as a teardown callback.
 */
function isBareCleanupOf(
    expression: Expression,
    name: string,
    collectionName: string | undefined,
): boolean {
    return (
        isBareDisposeOf(expression, name) ||
        ((nameLooksLikeDisposer.test(name) ||
            (collectionName !== undefined && nameLooksLikeDisposer.test(collectionName))) &&
            isBareCallOf(expression, name))
    );
}

/**
 * Rightmost identifier of a member chain, e.g. `this.mocks.listeners` -> `listeners`.
 */
function tailName(node: Node): string | undefined {
    if (node.type === 'Identifier') return node.name;
    if (
        node.type === 'MemberExpression' &&
        !node.computed &&
        (node.property.type === 'Identifier' || node.property.type === 'PrivateIdentifier')
    )
        return node.property.name;
    return undefined;
}

/**
 * Requires listener and cleanup fan-outs to isolate each callback.
 *
 * `for (const listener of listeners) listener(value);` stops at the first throwing listener, so every later subscriber
 * silently misses the update; the same loop over `dispose()` leaks every later subscription. Both go through
 * `@caxri/utils` instead: `notifyListeners` for values, `disposeAll` / `disposeAllThenRethrow` for cleanup.
 *
 * This started as a Vitest test that scanned the whole source tree as text. Test selection follows imports, and a test
 * that imports nothing is never selected by a changed-file check, so a violation passed every local gate and failed
 * only CI's full suite. As a lint rule it reports in the editor, at commit, and in `check --lint` on the changed file.
 */
const listenerFanoutIsolation: Rule.RuleModule = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Require listener and subscription fan-outs to isolate each callback through @caxri/utils.',
        },
        schema: [],
        messages: {
            fanout: 'Notify listeners through `notifyListeners` from `@caxri/utils` so one throwing listener cannot starve the rest.',
            cleanup:
                'Release subscriptions through `disposeAll` or `disposeAllThenRethrow` from `@caxri/utils` so one throwing cleanup cannot leak the rest.',
        },
    },
    create(context) {
        return {
            ForOfStatement(node) {
                if (node.left.type !== 'VariableDeclaration') return;
                // `.at(0)` (rather than `[0]`) keeps this typed as possibly `undefined`, since a for-of loop's
                // grammar guarantees exactly one binding but the AST's array type does not encode that.
                const binding = node.left.declarations.at(0)?.id;
                const expression = soleExpression(node.body);
                if (!expression || binding?.type !== 'Identifier') return;
                const loopVariable = binding.name;
                // Flags a value fan-out only when the loop variable itself (not the collection it came from) reads as a
                // fan-out target, since that is the name a caller actually invokes.
                if (
                    nameLooksLikeFanout.test(loopVariable) &&
                    isBareCallOf(expression, loopVariable)
                )
                    context.report({ node, messageId: 'fanout' });
                // `for (const remove of removers) remove();` names the teardown after the collection, so either name
                // may carry the cleanup meaning.
                else if (isBareCleanupOf(expression, loopVariable, tailName(node.right)))
                    context.report({ node, messageId: 'cleanup' });
            },
            /**
             * `listeners.forEach((listener) => listener(value))`: the same bug shaped as a callback instead of a loop.
             * Matched on the collection's name since a `forEach` callback parameter is often left anonymous or
             * abbreviated.
             */
            CallExpression(node) {
                const callee = node.callee;
                if (
                    callee.type !== 'MemberExpression' ||
                    callee.computed ||
                    callee.property.type !== 'Identifier' ||
                    callee.property.name !== 'forEach'
                )
                    return;
                // `.at(0)` keeps this possibly `undefined`, since `.forEach()` with no argument is invalid at runtime
                // but still a parseable, zero-argument call expression.
                const callback = node.arguments.at(0);
                if (
                    callback?.type !== 'ArrowFunctionExpression' &&
                    callback?.type !== 'FunctionExpression'
                )
                    return;
                const parameter = callback.params.length === 1 ? callback.params[0] : undefined;
                if (parameter?.type !== 'Identifier') return;
                const expression =
                    callback.body.type === 'BlockStatement'
                        ? soleExpression(callback.body)
                        : callback.body;
                if (!expression) return;
                const collectionName = tailName(callee.object);
                if (
                    collectionName !== undefined &&
                    nameLooksLikeFanout.test(collectionName) &&
                    isBareCallOf(expression, parameter.name)
                )
                    context.report({ node, messageId: 'fanout' });
                else if (isBareCleanupOf(expression, parameter.name, collectionName))
                    context.report({ node, messageId: 'cleanup' });
            },
        };
    },
};

export default listenerFanoutIsolation;

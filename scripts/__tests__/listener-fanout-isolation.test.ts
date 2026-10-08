import { glob, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');
const nameLooksLikeFanout = /listener|subscriber|handler/iu;
/**
 * Names a teardown callback reads under when a cleanup fan-out invokes it bare: `for (const dispose of removers)
 * dispose();`.
 */
const nameLooksLikeDisposer = /dispos|unsubscribe|remov|cleanup|teardown/iu;

/**
 * Reduces a for-of/forEach body to the one statement it must be to match the bug this guard targets: `for (const
 * listener of listeners) listener(value);`, with or without braces. A body with more than one statement, or none, is
 * exactly the shape an isolating rewrite produces (a `try`/`catch`, or a call through the shared `notifyListeners`
 * helper instead), so it is never a candidate.
 */
function soleStatement(body: ts.Statement): ts.Statement | undefined {
    if (ts.isBlock(body)) return body.statements.length === 1 ? body.statements[0] : undefined;
    return body;
}

/**
 * True when `statement` is nothing but `<name>(...)`: the loop or callback parameter invoked directly as a function. A
 * method call on the parameter (`listener.dispose()`) has a `PropertyAccessExpression` callee instead of a bare
 * identifier, so this does not match cleanup fan-outs; {@link isBareDisposeOf} covers those.
 */
function isBareCallOf(statement: ts.Statement, name: string): boolean {
    return (
        ts.isExpressionStatement(statement) &&
        ts.isCallExpression(statement.expression) &&
        ts.isIdentifier(statement.expression.expression) &&
        statement.expression.expression.text === name
    );
}

/**
 * True when `statement` is nothing but `<name>.dispose()` (or `<name>?.dispose()`): the cleanup fan-out shape. A loop
 * of these stops at the first throwing `dispose()` and leaks every later subscription, so it must go through
 * `@caxri/utils`'s `disposeAll` / `disposeAllThenRethrow` instead (caxri#1462). A single `dispose()` call outside a
 * loop is never passed here, so it is never flagged.
 */
function isBareDisposeOf(statement: ts.Statement, name: string): boolean {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
        return false;
    const callee = statement.expression.expression;
    return (
        ts.isPropertyAccessExpression(callee) &&
        callee.name.text === 'dispose' &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === name
    );
}

/**
 * True when `statement` releases the loop or callback binding `name` without isolation: either `<name>.dispose()`, or a
 * bare `<name>()` where `name` reads as a teardown callback.
 */
function isBareCleanupOf(statement: ts.Statement, name: string): boolean {
    return (
        isBareDisposeOf(statement, name) ||
        (nameLooksLikeDisposer.test(name) && isBareCallOf(statement, name))
    );
}

/**
 * Rightmost identifier of a member chain, e.g. `this.mocks.listeners` -> `listeners`.
 */
function tailName(expression: ts.Expression): string | undefined {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return undefined;
}

/**
 * Lines of `source` holding an unisolated value fan-out (`fanouts`) or an unisolated cleanup fan-out (`cleanups`).
 */
function scanFanouts(path: string, source: string): { cleanups: number[]; fanouts: number[] } {
    const fanouts: number[] = [];
    const cleanups: number[] = [];
    const sourceFile = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const line = (node: ts.Node) =>
        sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;

    const visit = (node: ts.Node): void => {
        // `for (const listener of listeners) listener(value);`: flags only when the loop variable itself (not the
        // collection it came from) reads as a fan-out target, since that is the name a caller actually invokes.
        if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
            // `.at(0)` (rather than array destructuring) keeps this typed as possibly `undefined`, since a for-of
            // loop's grammar guarantees exactly one binding but `NodeArray`'s element type does not encode that.
            const declaration = node.initializer.declarations.at(0);
            const statement = soleStatement(node.statement);
            if (declaration && statement && ts.isIdentifier(declaration.name)) {
                const loopVariable = declaration.name.text;
                const collectionName = tailName(node.expression);
                if (nameLooksLikeFanout.test(loopVariable) && isBareCallOf(statement, loopVariable))
                    fanouts.push(line(node));
                // `for (const remove of removers) remove();` names the teardown after the collection, so either
                // name may carry the cleanup meaning.
                else if (
                    isBareCleanupOf(statement, loopVariable) ||
                    (collectionName !== undefined &&
                        nameLooksLikeDisposer.test(collectionName) &&
                        isBareCallOf(statement, loopVariable))
                )
                    cleanups.push(line(node));
            }
        }

        // `listeners.forEach((listener) => listener(value))`: the same bug shaped as a callback instead of a loop.
        // Matched on the collection's name since a `forEach` callback parameter is often left anonymous or
        // abbreviated.
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'forEach'
        ) {
            const collectionName = tailName(node.expression.expression);
            // `.at(0)` keeps this possibly `undefined`, since `.forEach()` with no argument is invalid at runtime but
            // still a parseable, zero-argument call expression.
            const callback = node.arguments.at(0);
            if (
                callback &&
                (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
                callback.parameters.length === 1 &&
                ts.isIdentifier(callback.parameters[0].name)
            ) {
                const parameterName = callback.parameters[0].name.text;
                const statement = ts.isBlock(callback.body)
                    ? soleStatement(callback.body)
                    : ts.factory.createExpressionStatement(callback.body);
                if (statement) {
                    if (
                        collectionName !== undefined &&
                        nameLooksLikeFanout.test(collectionName) &&
                        isBareCallOf(statement, parameterName)
                    )
                        fanouts.push(line(node));
                    else if (
                        isBareCleanupOf(statement, parameterName) ||
                        (collectionName !== undefined &&
                            nameLooksLikeDisposer.test(collectionName) &&
                            isBareCallOf(statement, parameterName))
                    )
                        cleanups.push(line(node));
                }
            }
        }

        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return { cleanups, fanouts };
}

describe('listener fan-out isolation', () => {
    it('never fans out to listeners or disposes subscriptions through an unisolated loop', async () => {
        const bareFanouts: string[] = [];
        const bareCleanups: string[] = [];
        let scanned = 0;

        // Source lives under each workspace, never at a root-level `src/`; a glob that matches no
        // file makes this gate vacuously green, which is why the count below is asserted too.
        const sourcePaths = glob('{apps,packages,extensions}/*/src/**/*.{ts,tsx}', {
            cwd: repoRoot,
        });
        for await (const path of sourcePaths) {
            // Generated bundles (for example the mobile Terminal WebView's inlined xterm) are vendored output, not
            // source anyone edits here.
            if (path.includes('/__tests__/') || /\.(?:e2e|test|generated)\.tsx?$/u.test(path))
                continue;
            scanned += 1;
            const { cleanups, fanouts } = scanFanouts(
                path,
                await readFile(resolve(repoRoot, path), 'utf8'),
            );
            bareFanouts.push(...fanouts.map((line) => `${path}:${line}`));
            bareCleanups.push(...cleanups.map((line) => `${path}:${line}`));
        }

        expect(scanned).toBeGreaterThan(100);
        expect(bareFanouts).toEqual([]);
        // Cleanup fan-outs (`for (const d of xs) d.dispose()`) must go through `disposeAll` /
        // `disposeAllThenRethrow` so one throwing `dispose()` cannot leak later subscriptions.
        expect(bareCleanups).toEqual([]);
    });

    it('flags bare cleanup loops without flagging single or isolated dispose calls', () => {
        const source = [
            'for (const subscription of subscriptions) subscription.dispose();',
            'for (const listener of listeners) { listener?.dispose(); }',
            'for (const dispose of this.executionListeners) dispose();',
            'for (const remove of removers) remove();',
            'disposables.forEach((disposable) => disposable.dispose());',
            'cleanups.forEach((stop) => { stop(); });',
            'editor.dispose();',
            'this.promptMarker?.dispose();',
            'disposeAll(subscriptions);',
            'for (const item of items) item.close();',
            'for (const subscription of subscriptions) { try { subscription.dispose(); } catch {} }',
            'for (const command of commands) { command.decoration?.dispose(); command.startMarker.dispose(); }',
        ].join('\n');

        expect(scanFanouts('fixture.ts', source)).toEqual({
            cleanups: [1, 2, 3, 4, 5, 6],
            fanouts: [],
        });
    });
});

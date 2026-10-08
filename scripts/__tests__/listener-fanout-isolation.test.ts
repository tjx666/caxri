import { glob, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');
const nameLooksLikeFanout = /listener|subscriber|handler/iu;

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
 * identifier, so this intentionally does not match cleanup fan-outs that dispose every subscription rather than deliver
 * one value to every subscriber.
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
 * Rightmost identifier of a member chain, e.g. `this.mocks.listeners` -> `listeners`.
 */
function tailName(expression: ts.Expression): string | undefined {
    if (ts.isIdentifier(expression)) return expression.text;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    return undefined;
}

describe('listener fan-out isolation', () => {
    it('never delivers to multiple listeners/subscribers/handlers through an unisolated loop', async () => {
        const bareFanouts: string[] = [];
        let scanned = 0;

        // Source lives under each workspace, never at a root-level `src/`; a glob that matches no
        // file makes this gate vacuously green, which is why the count below is asserted too.
        const sourcePaths = glob('{apps,packages,extensions}/*/src/**/*.{ts,tsx}', {
            cwd: repoRoot,
        });
        for await (const path of sourcePaths) {
            if (path.includes('/__tests__/') || /\.(?:e2e|test)\.tsx?$/u.test(path)) continue;
            scanned += 1;
            const source = await readFile(resolve(repoRoot, path), 'utf8');
            const sourceFile = ts.createSourceFile(
                path,
                source,
                ts.ScriptTarget.Latest,
                true,
                path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
            );
            const flag = (node: ts.Node) =>
                bareFanouts.push(
                    `${path}:${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
                );

            const visit = (node: ts.Node): void => {
                // `for (const listener of listeners) listener(value);`: flags only when the loop variable itself
                // (not the collection it came from) reads as a fan-out target, since that is the name a caller
                // actually invokes.
                if (ts.isForOfStatement(node) && ts.isVariableDeclarationList(node.initializer)) {
                    // `.at(0)` (rather than array destructuring) keeps this typed as possibly `undefined`, since a
                    // for-of loop's grammar guarantees exactly one binding but `NodeArray`'s element type does not
                    // encode that.
                    const declaration = node.initializer.declarations.at(0);
                    if (
                        declaration &&
                        ts.isIdentifier(declaration.name) &&
                        nameLooksLikeFanout.test(declaration.name.text)
                    ) {
                        const loopVariable = declaration.name.text;
                        const statement = soleStatement(node.statement);
                        if (statement && isBareCallOf(statement, loopVariable)) flag(node);
                    }
                }

                // `listeners.forEach((listener) => listener(value))`: the same bug shaped as a callback instead of
                // a loop. Matched on the collection's name since a `forEach` callback parameter is often left
                // anonymous or abbreviated.
                if (
                    ts.isCallExpression(node) &&
                    ts.isPropertyAccessExpression(node.expression) &&
                    node.expression.name.text === 'forEach'
                ) {
                    const collectionName = tailName(node.expression.expression);
                    // `.at(0)` keeps this possibly `undefined`, since `.forEach()` with no argument is invalid at
                    // runtime but still a parseable, zero-argument call expression.
                    const callback = node.arguments.at(0);
                    if (
                        collectionName &&
                        callback &&
                        nameLooksLikeFanout.test(collectionName) &&
                        (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
                        callback.parameters.length === 1 &&
                        ts.isIdentifier(callback.parameters[0].name)
                    ) {
                        const parameterName = callback.parameters[0].name.text;
                        const statement = ts.isBlock(callback.body)
                            ? soleStatement(callback.body)
                            : ts.factory.createExpressionStatement(callback.body);
                        if (statement && isBareCallOf(statement, parameterName)) flag(node);
                    }
                }

                ts.forEachChild(node, visit);
            };
            visit(sourceFile);
        }

        expect(scanned).toBeGreaterThan(100);
        expect(bareFanouts).toEqual([]);
    });
});

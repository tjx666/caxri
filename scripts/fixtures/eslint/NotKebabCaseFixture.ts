/**
 * Fixture proving `unicorn/filename-case` is enabled for JS/TS files. This filename intentionally
 * violates the `kebabCase` requirement configured in `eslint.config.ts`; see
 * `scripts/__tests__/eslint-toolchain-contract.test.ts`. Not imported by any production or test
 * module.
 */
export const notKebabCaseFixtureId = 'not-kebab-case-fixture';

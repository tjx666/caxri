/**
 * Child-process environments for CI validation. Each child receives the job environment minus what it must not see.
 */

/**
 * Keeps the command-scoped checkout token out of every validation child.
 */
export function sanitizedChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const sanitized = { ...environment };
    delete sanitized.CAXRI_GITHUB_TOKEN;
    return sanitized;
}

/**
 * Electron-vite resolves the development entry from the root package manifest by default, but the workspace root
 * intentionally has no product entrypoint. Keep the Desktop output explicit while retaining the root working directory
 * required by electron.vite.config.ts.
 */
export const developmentCommands = [
    ['pnpm', '--filter', '@caxri/server', 'run', 'dev'],
    ['electron-vite', 'dev', '--entry', 'out/main/index.js'],
] as const;

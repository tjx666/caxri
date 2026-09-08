/**
 * Ambient declarations for Vite virtual modules. Kept import-free on purpose: a `declare module` inside a file with
 * top-level imports becomes a module augmentation instead of an ambient module declaration.
 */

/** Resolved by the `caxri-react-scan-boot` plugin in electron.vite.config.ts; empty unless `CAXRI_REACT_SCAN=1`. */
declare module 'virtual:caxri-react-scan-boot' {}

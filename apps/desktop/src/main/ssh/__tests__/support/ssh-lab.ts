import process from 'node:process';

/**
 * The opt-in real-`sshd` lab shared by the SSH integration suites. See `docs/remote-ssh.md#testing`.
 */
export const isSshIntegrationEnabled = process.env.CAXRI_SSH_INTEGRATION === '1';
/**
 * `-F` file that keeps the lab's keys and hosts away from the developer's own `~/.ssh`.
 */
export const labConfigFile = process.env.CAXRI_SSH_CONFIG;
/**
 * Lab host to drive; may sit behind a `ProxyJump`.
 */
export const labDestination = process.env.CAXRI_SSH_DESTINATION ?? 'caxri-lab';

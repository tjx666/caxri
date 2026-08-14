export { defaultAgentEnvironment, type AgentEnvironment } from './contract';
export { AgentCoordinator } from './coordinator';
export { discoverExecutable, readVersion } from './discovery';
export { AgentHookManager } from './hooks';
export type { AgentLifecyclePhase, AgentLifecycleSignal } from './hooks/contract';
export { AgentService, createLocalAgentAdapters, type AgentAdapter } from './service';

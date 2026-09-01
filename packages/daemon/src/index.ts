export type { ExitCode } from './exit.ts';
export { EXIT } from './exit.ts';
export type { DaemonOptions } from './main.ts';
export { announceSecretProtection, runDaemon } from './main.ts';
export type {
  EarlySignals,
  SignalOptions,
  SignalWatch,
  StopRequest,
  StopSignal,
} from './signals.ts';
export { watchForStop } from './signals.ts';

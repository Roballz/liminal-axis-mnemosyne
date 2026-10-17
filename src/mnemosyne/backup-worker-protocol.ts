import type { BackupOutcome } from './core-backups';

export type BackupJob = { library: string; kind: 'auto'; keep: 20 };
export type BackupResult = BackupOutcome;
export type DiskCall = (
    { method: 'guard' | 'list' } | { method: 'read' | 'remove'; key: string } |
    { method: 'write'; key: string; blob: Blob }
);
export type DiskRequest = { type: 'rpc'; id: number } & DiskCall;
export type WorkerMessage = DiskRequest | { type: 'ready' } |
    { type: 'done'; result: BackupResult } | { type: 'failed'; error: string };
export type HostMessage = { type: 'start'; job: BackupJob } |
    { type: 'reply'; id: number; result?: unknown; error?: string };

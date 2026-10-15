import type { BackupOutcome, BackupPreview } from './core-backups';
import type { Branch } from './model';

export type BackupJob = { library: string } & (
    { kind: 'auto'; keep: 5 | 10 } | { kind: 'protect-deletion'; expected: Branch }
);
export type BackupResult = BackupOutcome | BackupPreview;
export type DiskCall = (
    { method: 'guard' | 'list' } | { method: 'read' | 'remove'; key: string } |
    { method: 'write'; key: string; blob: Blob }
);
export type DiskRequest = { type: 'rpc'; id: number } & DiskCall;
export type WorkerMessage = DiskRequest | { type: 'ready' } |
    { type: 'protected'; entry: BackupPreview } |
    { type: 'done'; result: BackupResult } | { type: 'failed'; error: string };
export type HostMessage = { type: 'start'; job: BackupJob } |
    { type: 'reply'; id: number; result?: unknown; error?: string };

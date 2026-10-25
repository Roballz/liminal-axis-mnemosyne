import type { BackupOutcome, BackupPreview, BackupSaveKind } from './core-backups';
import type { Package } from './migration';

export type BackupJob = { library: string; kind: BackupSaveKind; keep: 20 } | { kind: 'preview'; key: string } |
    { kind: 'pin'; key: string; checksum: string } | { kind: 'restore'; key: string; checksum: string } |
    { kind: 'export'; library: string } | { kind: 'import'; blob: Blob };
export type BackupResult = BackupOutcome | { state: 'preview' | 'pinned'; entry: BackupPreview } |
    { state: 'exported'; blob: Blob; version: Package['version'] } | { state: 'restored'; library: string };
export type DiskCall = (
    { method: 'guard' | 'list' | 'readPreviews' } | { method: 'read' | 'remove'; key: string } |
    { method: 'write'; key: string; blob: Blob } | { method: 'writePreviews'; value: unknown }
);
export type DiskRequest = { type: 'rpc'; id: number } & DiskCall;
export type WorkerMessage = DiskRequest | { type: 'ready' } |
    { type: 'done'; result: BackupResult } | { type: 'failed'; error: string };
export type HostMessage = { type: 'start'; job: BackupJob } |
    { type: 'reply'; id: number; result?: unknown; error?: string };

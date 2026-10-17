import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { fixture } from './fixtures';
import { CoreBackups } from './core-backups';
import { Library } from './db';
import type { BackupDisk } from '@/st/native-backups';
import type { HostMessage, WorkerMessage } from './backup-worker-protocol';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test('actual preview worker validates just the selected full package without opening a database', async () => {
    const { lib } = await fixture(1), files = new Map<string, Blob>();
    const disk: BackupDisk = { list: async () => [...files.keys()], read: async key => files.get(key)!,
        write: async (key, blob) => { files.set(key, blob); }, remove: async () => {}, readSettings: async () => undefined, writeSettings: async () => {} };
    const saved = await new CoreBackups(disk).save(lib, 'manual');
    if (saved.state !== 'saved') throw new Error('missing backup');
    lib.close(); const open = vi.spyOn(Library, 'open');
    const messages: WorkerMessage[] = [];
    const host = { onmessage: undefined as unknown as (event: { data: HostMessage }) => Promise<void>, postMessage: (message: WorkerMessage) => {
        messages.push(message);
        if (message.type === 'rpc') {
            expect(message.method).toBe('read');
            expect('key' in message && message.key).toBe(saved.entry.key);
            queueMicrotask(() => { void host.onmessage({ data: { type: 'reply', id: message.id, result: files.get(saved.entry.key) } }); });
        }
    } };
    vi.stubGlobal('self', host);
    await import('./core-backup.worker');
    await host.onmessage({ data: { type: 'start', job: { kind: 'preview', key: saved.entry.key } } });
    expect(messages.filter(message => message.type === 'rpc')).toHaveLength(1);
    expect(messages.at(-1)).toEqual({ type: 'done', result: { state: 'preview', entry: saved.entry } });
    expect(open).not.toHaveBeenCalled();
});

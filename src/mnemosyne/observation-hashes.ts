import type { HostObservation } from './canonical';
import type { Library } from './db';
import { HostVersionMemo } from './host-version';
import { fingerprint } from './model';

interface MessageHash { role: string; content: string; hash: string; bodyHash: string }
interface MemoryHash { memo: HostVersionMemo; encoded: string; hash: string }
interface ObservationHashes {
    scope: string;
    messages: Map<string, MessageHash>;
    memories: Map<string, MemoryHash>;
}
// One observation per connection. These are pure value hashes, never proof that
// database rows or the displayed host are current; normal transaction guards remain.
const observations = new WeakMap<Library, ObservationHashes>();

async function encodedFingerprint(encoded: string): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(encoded));
    return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function observationHashes(lib: Library, observation: HostObservation) {
    const saved = observations.get(lib);
    const prior = saved?.scope === observation.scope ? saved : undefined;
    const next: ObservationHashes = { scope: observation.scope, messages: new Map(), memories: new Map() };
    const [messages, memories] = await Promise.all([
        Promise.all(observation.messages.map(async message => {
            const previous = prior?.messages.get(message.key);
            const { role, content } = message;
            const sameBody = previous?.content === content;
            const [hash, bodyHash] = await Promise.all([
                sameBody && previous.role === role ? previous.hash : fingerprint([role, content]),
                sameBody ? previous.bodyHash : fingerprint(content),
            ]);
            const value = { role, content, hash, bodyHash };
            next.messages.set(message.key, value);
            return value;
        })),
        Promise.all(observation.memories.map(async memory => {
            const previous = prior?.memories.get(memory.hostId);
            const memo = previous?.memo ?? new HostVersionMemo();
            const encoded = memo.read(memory);
            const hash = previous?.encoded === encoded ? previous.hash : await encodedFingerprint(encoded);
            next.memories.set(memory.hostId, { memo, encoded, hash });
            return hash;
        })),
    ]);
    // Concurrent calls may finish in either order. A completed value cache is
    // harmless even after a failed write; never retain observations from other scopes.
    observations.set(lib, next);
    return { hashes: messages.map(m => m.hash), bodyHashes: messages.map(m => m.bodyHash), memoryHashes: memories };
}

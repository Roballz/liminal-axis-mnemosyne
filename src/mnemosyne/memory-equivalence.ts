import { equal, type MemoryRevision } from './model';

/** Metadata edits do not change narrative evidence. All source/version fields must match. */
export function sameNarrativeRevision(a: MemoryRevision, b: MemoryRevision): boolean {
    const narrative = ({ id, fingerprint, tags, ...rest }: MemoryRevision) => rest;
    return equal(narrative(a), narrative(b));
}

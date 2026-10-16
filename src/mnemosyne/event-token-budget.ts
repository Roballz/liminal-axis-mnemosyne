import type { ChatMsg } from '@/api/client';

// No provider tokenizer is available. UTF-8 bytes / 2 plus 15% and 1024 tokens
// is deliberately conservative for ordinary mixed Chinese/Latin text, but is
// an estimate, not a guarantee for every tokenizer or provider chat template.
// This bounds input only: the channel's output max_tokens remains independent.
export const eventInputBytes = (text: string) => new TextEncoder().encode(text).length;
export const estimateEventInputBytes = (bytes: number) => Math.ceil(bytes * 0.575) + 1024;
export const estimateEventInputTokens = (messages: ChatMsg[]) => estimateEventInputBytes(eventInputBytes(JSON.stringify(messages)));

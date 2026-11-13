import { describe, expect, it } from 'vitest';
import { readJsonBodyLimited } from '../lib/app';

describe('readJsonBodyLimited', () => {
  it('parses a valid JSON request within the byte budget', async () => {
    const request = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    const result = await readJsonBodyLimited(request, 1024);
    expect(result).toEqual({ ok: true, value: { text: 'hello' } });
  });

  it('rejects a request from Content-Length before reading its body', async () => {
    const request = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': '1000' },
      body: '{}',
    });
    const result = await readJsonBodyLimited(request, 10);
    expect(result).toEqual({
      ok: false,
      status: 413,
      error: 'request body exceeds the configured size limit',
    });
  });

  it('enforces the byte budget while reading chunked bodies without Content-Length', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"text":"this payload is larger than the configured limit"}'));
        controller.close();
      },
    });
    const request = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    const result = await readJsonBodyLimited(request, 16);
    expect(result).toEqual({
      ok: false,
      status: 413,
      error: 'request body exceeds the configured size limit',
    });
  });

  it('returns a clear 400 for malformed JSON', async () => {
    const request = new Request('https://example.test/api', {
      method: 'POST',
      body: '{invalid',
    });
    const result = await readJsonBodyLimited(request, 1024);
    expect(result).toEqual({ ok: false, status: 400, error: 'request body must be valid JSON' });
  });
});

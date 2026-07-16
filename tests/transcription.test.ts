import { describe, expect, it, vi } from 'vitest';
import { HumanError } from '../src/errors';
import { buildMultipart, OpenAITranscriber } from '../src/transcription';

describe('buildMultipart', () => {
  it('includes model and binary file in a standards-compliant multipart body', () => {
    const body = buildMultipart(
      { fileName: 'voice.oga', data: new TextEncoder().encode('audio-bytes').buffer },
      'whisper-1',
      'test-boundary',
    );
    const text = new TextDecoder().decode(body);
    expect(text).toContain('name="model"\r\n\r\nwhisper-1');
    expect(text).toContain('name="file"; filename="voice.oga"');
    expect(text).toContain('Content-Type: application/octet-stream');
    expect(text).toContain('audio-bytes');
    expect(text).toContain('--test-boundary--\r\n');
  });

  it('escapes unsafe characters in a multipart filename', () => {
    const body = buildMultipart(
      { fileName: 'bad"\r\nInjected: yes.oga', data: new ArrayBuffer(0) },
      'model',
      'b',
    );
    const text = new TextDecoder().decode(body);
    expect(text).not.toContain('\r\nInjected:');
    expect(text).toContain('filename="bad__Injected: yes.oga"');
  });
});

describe('OpenAITranscriber', () => {
  it('posts to an OpenAI-compatible endpoint and returns trimmed text', async () => {
    const request = vi.fn(async () => ({ status: 200, json: { text: '  hello world  ' } }));
    const client = new OpenAITranscriber(request as never, () => 'fixed-boundary');
    const text = await client.transcribe(
      { fileName: 'voice.oga', data: new Uint8Array([1, 2, 3]).buffer },
      { baseUrl: 'https://stt.example/v1/', apiKey: 'secret', model: 'whisper-large-v3' },
    );
    expect(text).toBe('hello world');
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://stt.example/v1/audio/transcriptions',
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          'Content-Type': 'multipart/form-data; boundary=fixed-boundary',
        }),
        body: expect.any(ArrayBuffer),
        throw: false,
      }),
    );
  });

  it('surfaces HTTP errors without leaking the API key', async () => {
    const request = vi.fn(async () => ({ status: 401, json: { error: { message: 'bad key' } } }));
    const client = new OpenAITranscriber(request as never, () => 'b');
    await expect(
      client.transcribe(
        { fileName: 'voice.oga', data: new ArrayBuffer(1) },
        { baseUrl: 'https://stt.example/v1', apiKey: 'top-secret', model: 'm' },
      ),
    ).rejects.toSatisfy(
      (error) => error instanceof HumanError && error.key === 'error.transcriptionFailed' && !error.human.includes('top-secret'),
    );
  });

  it('rejects an empty successful response', async () => {
    const request = vi.fn(async () => ({ status: 200, json: { text: '   ' } }));
    const client = new OpenAITranscriber(request as never, () => 'b');
    await expect(
      client.transcribe(
        { fileName: 'voice.oga', data: new ArrayBuffer(1) },
        { baseUrl: 'https://stt.example/v1', apiKey: 'k', model: 'm' },
      ),
    ).rejects.toSatisfy((error) => error instanceof HumanError && error.key === 'error.transcriptionFailed');
  });
});

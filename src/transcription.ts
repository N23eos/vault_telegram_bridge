import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from 'obsidian';
import { errTranscriptionFailed } from './errors';

export interface TranscriptionFile {
  fileName: string;
  data: ArrayBuffer;
}

export interface TranscriptionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface Transcriber {
  transcribe(file: TranscriptionFile, config: TranscriptionConfig): Promise<string>;
}

type Request = (params: RequestUrlParam) => Promise<RequestUrlResponse>;

export class OpenAITranscriber implements Transcriber {
  constructor(
    private readonly request: Request = async (params) => requestUrl(params),
    private readonly boundary: () => string = () => `----vault-telegram-${crypto.randomUUID()}`,
  ) {}

  async transcribe(file: TranscriptionFile, config: TranscriptionConfig): Promise<string> {
    const boundary = this.boundary();
    let response: RequestUrlResponse;
    try {
      response = await this.request({
        url: `${config.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body: buildMultipart(file, config.model, boundary),
        throw: false,
      });
    } catch (error) {
      throw errTranscriptionFailed('network error', error);
    }

    if (response.status < 200 || response.status >= 300) {
      throw errTranscriptionFailed(`HTTP ${response.status}`);
    }

    const body = response.json as { text?: unknown } | undefined;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (text === '') throw errTranscriptionFailed('empty response');
    return text;
  }
}

export function buildMultipart(file: TranscriptionFile, model: string, boundary: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const safeName = file.fileName.replace(/"/g, '_').replace(/[\r\n]+/g, '_');
  const prefix = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="model"\r\n\r\n${model}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  const output = new Uint8Array(prefix.byteLength + file.data.byteLength + suffix.byteLength);
  output.set(prefix, 0);
  output.set(new Uint8Array(file.data), prefix.byteLength);
  output.set(suffix, prefix.byteLength + file.data.byteLength);
  return output.buffer;
}

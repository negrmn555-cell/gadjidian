import http from 'node:http';
import { Transform, pipeline } from 'node:stream';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createGunzip, createBrotliDecompress, createInflate } from 'node:zlib';
import { DomainError } from '@relay/core';

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) === 6) {
    const value = address.toLowerCase();
    return /^[23][0-9a-f]{3}:/.test(value) && !/^2001:(?:db8|0|00):/.test(value) && !value.startsWith('2002:');
  }
  return false;
}

export function validateEndpointPolicy(baseUrl: string, allowedOrigins: string[]): URL {
  const url = new URL(baseUrl);
  const allowed = allowedOrigins.includes(url.origin);
  if (url.username || url.password || url.search || url.hash || (!allowed && url.protocol !== 'https:')) {
    throw new DomainError('ENDPOINT_FORBIDDEN', 'Нужен HTTPS API. Локальный адрес должен быть разрешён администратором сервера.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowed && (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && !isPublicAddress(host)))) {
    throw new DomainError('ENDPOINT_FORBIDDEN', 'Приватный адрес API не разрешён сервером.');
  }
  return url;
}

/** DNS answers are validated and pinned to this socket. Redirects are never followed. */
export function guardedTransport(allowedOrigins: string[], timeoutMs: number,
  resolveHost: (hostname: string) => Promise<{ address: string; family: number }[]> = hostname => lookup(hostname, { all: true, verbatim: true })): typeof fetch {
  return async (input, init) => {
    const url = new URL(String(input));
    const policyUrl = new URL(url);
    if (policyUrl.search === '?alt=sse') policyUrl.search = '';
    validateEndpointPolicy(policyUrl.toString(), allowedOrigins);
    const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs, 120_000)))]);
    try {
      signal.throwIfAborted();
      const host = url.hostname.replace(/^\[|\]$/g, '');
      let addresses: { address: string; family: number }[];
      if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
      else {
        let abort: () => void = () => {};
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(new Error('DNS lookup cancelled'));
          signal.addEventListener('abort', abort, { once: true });
        });
        try { addresses = await Promise.race([resolveHost(host), cancelled]); }
        finally { signal.removeEventListener('abort', abort); }
      }
      signal.throwIfAborted();
      if (!addresses.length || (!allowedOrigins.includes(url.origin) && addresses.some(a => !isPublicAddress(a.address)))) {
        throw new DomainError('ENDPOINT_FORBIDDEN', 'DNS адреса API ведут в запрещённую сеть.');
      }
      const selected = addresses[0];
      const body = typeof init?.body === 'string' ? init.body : init?.body instanceof Uint8Array ? Buffer.from(init.body) : '';
      if (Buffer.byteLength(body) > 10 * 1024 * 1024) throw new DomainError('PROVIDER_REQUEST_TOO_LARGE', 'Слишком большой запрос к модели.');
      return await new Promise<Response>((resolve, reject) => {
        const request = (url.protocol === 'https:' ? https : http).request(url, {
          method: init?.method ?? 'POST', headers: Object.fromEntries(new Headers(init?.headers).entries()), signal,
          agent: false,
          lookup: ((_name: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
            if (options.all) callback(null, [selected]); else callback(null, selected.address, selected.family);
          }) as NonNullable<http.RequestOptions['lookup']>,
        }, response => {
          const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
          const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : null;
          if (encoding && encoding !== 'identity' && !decoder) {
            const error = new DomainError('PROVIDER_PROTOCOL_ERROR', 'Неподдерживаемое сжатие ответа API.', 502);
            reject(error); request.destroy(error); return;
          }
          const limit = () => {
            let size = 0;
            return new Transform({ transform(chunk: Buffer, _encoding, done) {
              size += chunk.length;
              done(size > 2 * 1024 * 1024 ? new DomainError('PROVIDER_RESPONSE_TOO_LARGE', 'Ответ модели слишком большой.', 502) : null, chunk);
            } });
          };
          const rawLimit = limit(), decodedLimit = limit();
          const headers = new Headers();
          for (const [key, value] of Object.entries(response.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          headers.delete('content-encoding'); headers.delete('content-length');
          const status = response.statusCode ?? 502;
          // Pull from the iterator so cancelling a rejected HTTP response cannot race a queued enqueue.
          if (decoder) pipeline(response, rawLimit, decoder, decodedLimit, () => {});
          else pipeline(response, rawLimit, decodedLimit, () => {});
          const iterator=decodedLimit[Symbol.asyncIterator]();let closed=false;
          const body=new ReadableStream<Uint8Array>({
            async pull(controller){if(closed)return;try{const item=await iterator.next();if(closed)return;if(item.done){closed=true;controller.close();}else controller.enqueue(new Uint8Array(item.value));}catch(e){if(!closed){closed=true;controller.error(e);}}},
            async cancel(){closed=true;decodedLimit.destroy();request.destroy();try{await iterator.return?.();}catch{}},
          },{highWaterMark:64*1024,size:chunk=>chunk.byteLength});
          resolve(new Response([204, 205, 304].includes(status) ? null : body, { status, headers }));
        });
        request.setTimeout(Math.min(30_000, Math.max(1000, timeoutMs)), () => request.destroy(new DomainError('PROVIDER_IDLE_TIMEOUT', 'Модель перестала передавать ответ.', 504)));
        const firstByte = setTimeout(() => request.destroy(new DomainError('PROVIDER_FIRST_BYTE_TIMEOUT', 'Модель не начала ответ вовремя.', 504)), Math.min(30_000, Math.max(1000, timeoutMs)));
        const connect = setTimeout(() => request.destroy(new DomainError('PROVIDER_CONNECT_TIMEOUT', 'Не удалось установить соединение с API.', 504)), Math.min(10_000, Math.max(1000, timeoutMs)));
        connect.unref();
        request.once('socket', socket => { if(socket.connecting)socket.once(url.protocol==='https:'?'secureConnect':'connect',()=>clearTimeout(connect));else clearTimeout(connect); });
        firstByte.unref();
        request.once('response', () => clearTimeout(firstByte));
        request.once('close', () => {clearTimeout(firstByte);clearTimeout(connect);});
        request.on('error', reject);
        request.end(body);
      });
    } catch (e) {
      if (e instanceof DomainError) throw e;
      if (init?.signal?.aborted) throw new DomainError('PROVIDER_CANCELLED', 'Запрос к модели отменён.', 499);
      if (signal.aborted) throw new DomainError('PROVIDER_TIMEOUT', 'Модель не ответила вовремя.', 504);
      throw new DomainError('PROVIDER_NETWORK_ERROR', 'Не удалось подключиться к API модели.', 502);
    }
  };
}

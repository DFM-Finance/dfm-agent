import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRemoteServer } from './server.js';
import { scrubError } from './scrub.js';

export interface RemoteHttpOptions {
  apiUrl: string;
  version: string;
  /** Request paths that serve MCP (the proxy may or may not strip a prefix). */
  paths?: string[];
  /** A body-size cap, not a rate limit (constitution art. 4). */
  maxBodyBytes?: number;
}

const rpcError = (res: ServerResponse, status: number, message: string, extra: Record<string, string> = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extra });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
};

function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('body is not valid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function createRemoteHttpServer(opts: RemoteHttpOptions): Server {
  const paths = new Set(opts.paths ?? ['/mcp', '/api/v2/mcp']);
  const max = opts.maxBodyBytes ?? 64 * 1024;
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'content-type, authorization, accept, mcp-protocol-version',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
  return createServer(async (req, res) => {
    const path = (req.url ?? '').split('?')[0];
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    if (path === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (!paths.has(path)) return rpcError(res, 404, 'Not found');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    // Stateless JSON mode: no session, no server-sent stream to keep open.
    if (req.method !== 'POST') return rpcError(res, 405, 'Use POST', { Allow: 'POST, OPTIONS' });
    try {
      const body = await readBody(req, max);
      const { server } = createRemoteServer(opts.version, opts.apiUrl, req.headers.authorization);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (res.headersSent) return;
      const status = (e as { status?: number }).status ?? 500;
      rpcError(res, status, status === 500 ? 'Internal error' : scrubError((e as Error).message));
    }
  });
}

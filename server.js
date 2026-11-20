'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Registry } = require('./src/registry');

const PUBLIC_DIR = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};
const MAX_BODY = 1024 * 1024; // 1MB

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体超过 1MB 上限'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' });
  }
}

function serveStatic(res, filePath) {
  const resolved = path.normalize(filePath);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep) && resolved !== path.join(PUBLIC_DIR, 'index.html')) {
    sendJson(res, 403, { ok: false, error: '禁止访问' });
    return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) {
      sendJson(res, 404, { ok: false, error: '文件不存在' });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer(registry) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      // 页面与静态资源
      if (req.method === 'GET' && p === '/') {
        serveStatic(res, path.join(PUBLIC_DIR, 'index.html'));
        return;
      }
      if (req.method === 'GET' && p.startsWith('/static/')) {
        serveStatic(res, path.join(PUBLIC_DIR, p.slice('/static/'.length)));
        return;
      }

      // 业务接口
      if (req.method === 'GET' && p === '/api/state') {
        sendJson(res, 200, { ok: true, ...registry.state() });
        return;
      }
      if (req.method === 'POST' && p === '/api/import') {
        const body = await readJson(req);
        if (typeof body.csv !== 'string') {
          sendJson(res, 400, { ok: false, error: '缺少 csv 字段', code: 'BAD_REQUEST' });
          return;
        }
        const { batch, records } = registry.importCsv(body.csv, String(body.name || ''));
        sendJson(res, 200, { ok: true, batch, records });
        return;
      }
      if (req.method === 'POST' && p === '/api/mappings') {
        const body = await readJson(req);
        const result = registry.setMappingAndRerun(body.alias, body.canonical);
        sendJson(res, 200, { ok: true, ...result });
        return;
      }
      if (req.method === 'POST' && p === '/api/rerun') {
        sendJson(res, 200, { ok: true, rerun: registry.rerunRejected() });
        return;
      }
      const rowMatch = p.match(/^\/api\/rows\/([^/]+)$/);
      if (req.method === 'GET' && rowMatch) {
        const row = registry.getRow(decodeURIComponent(rowMatch[1]));
        if (!row) {
          sendJson(res, 404, { ok: false, error: '行不存在', code: 'ROW_NOT_FOUND' });
          return;
        }
        sendJson(res, 200, { ok: true, row, batch: registry.getBatch(row.batchId) });
        return;
      }

      sendJson(res, 404, { ok: false, error: '接口不存在', code: 'NOT_FOUND' });
    } catch (err) {
      const status =
        err.code === 'UNKNOWN_HEADER' || err.code === 'EMPTY_CSV' || err.code === 'CSV_UNCLOSED_QUOTE'
          ? 422
          : err.code === 'BAD_MAPPING' || err.code === 'BAD_JSON' || err.code === 'BAD_REQUEST'
            ? 400
            : err.code === 'BODY_TOO_LARGE'
              ? 413
              : 500;
      sendJson(res, status, { ok: false, error: err.message, code: err.code || 'INTERNAL' });
    }
  });
}

if (require.main === module) {
  const registry = new Registry();
  // 预置两处映射,让合成样例里既有可发布行、也有因未映射被拒收的行。
  registry.setMapping('一车间', '制造一部');
  registry.setMapping('二车间', '制造二部');
  const port = Number(process.env.PORT || 3000);
  createServer(registry).listen(port, '127.0.0.1', () => {
    console.log(`登记服务已启动: http://127.0.0.1:${port}`);
  });
}

module.exports = { createServer };

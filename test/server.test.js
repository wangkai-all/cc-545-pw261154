'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');
const { Registry } = require('../src/registry');

const V1_CSV = '编号,姓名,单位\n123,张三,一车间\n678,王五,质检组\n';
const V2_CSV = '编号,姓名,单位,部门\n0123,张三,一车间,装配线\n099,赵六,运输队,物流\n';

async function startServer(registry) {
  const server = createServer(registry);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

async function postJson(base, path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

function seededRegistry() {
  const r = new Registry();
  r.setMapping('一车间', '制造一部');
  return r;
}

test('页面可访问,业务结果区带 data-evidence-result 属性', async (t) => {
  const { server, base } = await startServer(seededRegistry());
  t.after(() => server.close());
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /data-evidence-result/);
  const app = await fetch(`${base}/static/app.js`);
  assert.equal(app.status, 200);
});

test('完整流程:导入两版 → 拒收 → 修订映射重跑 → 行级来历', async (t) => {
  const { server, base } = await startServer(seededRegistry());
  t.after(() => server.close());

  // 导入旧版:张三发布,王五(质检组未映射)拒收
  const imp1 = await postJson(base, '/api/import', { csv: V1_CSV, name: '旧版导出' });
  assert.equal(imp1.status, 200);
  assert.equal(imp1.data.batch.version, 'v1');
  assert.equal(imp1.data.batch.published, 1);
  assert.equal(imp1.data.batch.rejected, 1);

  // 导入新版:0123 与旧版 123 归并为同一人;赵六(运输队)拒收
  const imp2 = await postJson(base, '/api/import', { csv: V2_CSV, name: '新版导出' });
  assert.equal(imp2.data.batch.version, 'v2');

  let state = (await (await fetch(`${base}/api/state`)).json()).stats;
  assert.deepEqual(state, { batches: 2, rows: 4, published: 2, rejected: 2, people: 1 });

  // 修订一处映射并自动重跑:王五发布,赵六仍拒收
  const m1 = await postJson(base, '/api/mappings', { alias: '质检组', canonical: '质量部' });
  assert.equal(m1.status, 200);
  assert.deepEqual(m1.data.rerun, { retried: 2, published: 1, stillRejected: 1 });

  // 再补一处映射重跑:赵六也发布
  const m2 = await postJson(base, '/api/mappings', { alias: '运输队', canonical: '物流部' });
  assert.deepEqual(m2.data.rerun, { retried: 1, published: 1, stillRejected: 0 });

  state = (await (await fetch(`${base}/api/state`)).json()).stats;
  assert.deepEqual(state, { batches: 2, rows: 4, published: 4, rejected: 0, people: 3 });

  // 行级来历:王五那行有两次尝试,第二次用修订 2 的映射发布
  const rows = (await (await fetch(`${base}/api/state`)).json()).rows;
  const wangwu = rows.find((r) => r.raw['姓名'] === '王五');
  const prov = await (await fetch(`${base}/api/rows/${wangwu.id}`)).json();
  assert.equal(prov.ok, true);
  assert.equal(prov.batch.version, 'v1');
  assert.equal(prov.row.raw['编号'], '678');
  assert.equal(prov.row.attempts.length, 2);
  assert.equal(prov.row.attempts[0].result, 'rejected');
  assert.equal(prov.row.attempts[1].result, 'published');
  assert.equal(prov.row.mapping.canonical, '质量部');
});

test('异常:无法识别的表头返回 422,空内容返回 422', async (t) => {
  const { server, base } = await startServer(seededRegistry());
  t.after(() => server.close());

  const bad = await postJson(base, '/api/import', { csv: '工号,名字\n1,甲\n' });
  assert.equal(bad.status, 422);
  assert.equal(bad.data.code, 'UNKNOWN_HEADER');

  const empty = await postJson(base, '/api/import', { csv: '' });
  assert.equal(empty.status, 422);
  assert.equal(empty.data.code, 'EMPTY_CSV');
});

test('异常:缺 csv 字段 400,非法 JSON 400,空映射 400', async (t) => {
  const { server, base } = await startServer(seededRegistry());
  t.after(() => server.close());

  const noCsv = await postJson(base, '/api/import', { name: 'x' });
  assert.equal(noCsv.status, 400);

  const badJson = await fetch(`${base}/api/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{oops',
  });
  assert.equal(badJson.status, 400);

  const badMapping = await postJson(base, '/api/mappings', { alias: '', canonical: '质量部' });
  assert.equal(badMapping.status, 400);
});

test('异常:不存在的行 404,未知路由 404', async (t) => {
  const { server, base } = await startServer(seededRegistry());
  t.after(() => server.close());

  const row = await (await fetch(`${base}/api/rows/R999`)).json();
  assert.equal(row.ok, false);

  const res = await fetch(`${base}/api/nope`);
  assert.equal(res.status, 404);
});

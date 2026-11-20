'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Registry, detectVersion, normalizePersonId } = require('../src/registry');

const V1_CSV = '编号,姓名,单位\n123,张三,一车间\n45,李四,二车间\n678,王五,质检组\n';
const V2_CSV = '编号,姓名,单位,部门\n0123,张三,一车间,装配线\n045,李四,二车间,机加工\n099,赵六,运输队,物流\n';

function seeded() {
  const r = new Registry();
  r.setMapping('一车间', '制造一部');
  r.setMapping('二车间', '制造二部');
  return r;
}

test('辨版本:旧版、新版与无法识别的表头', () => {
  assert.equal(detectVersion(['编号', '姓名', '单位']), 'v1');
  assert.equal(detectVersion(['编号', '姓名', '单位', '部门']), 'v2');
  assert.equal(detectVersion(['工号', '姓名']), null);
});

test('编号归一:去前导零,非数字为异常', () => {
  assert.equal(normalizePersonId('0123'), '123');
  assert.equal(normalizePersonId('123'), '123');
  assert.equal(normalizePersonId('000'), '0');
  assert.equal(normalizePersonId(' 045 '), '45');
  assert.equal(normalizePersonId('A123'), null);
  assert.equal(normalizePersonId(''), null);
  assert.equal(normalizePersonId(null), null);
});

test('正常:映射可解释的行发布,部门列仅新版有值', () => {
  const r = seeded();
  const { batch, records } = r.importCsv(V2_CSV, '新版导出');
  assert.equal(batch.version, 'v2');
  assert.equal(batch.published, 2);
  assert.equal(batch.rejected, 1); // 运输队未映射
  const zhangsan = records[0];
  assert.equal(zhangsan.status, 'published');
  assert.equal(zhangsan.personId, '123'); // 0123 归一为 123
  assert.equal(zhangsan.unit, '制造一部');
  assert.equal(zhangsan.dept, '装配线');
  assert.equal(zhangsan.raw['编号'], '0123'); // 原始值保留前导零
});

test('异常:单位未映射的行拒收并写明原因,不进入名册', () => {
  const r = seeded();
  r.importCsv(V1_CSV);
  const wangwu = r.rows.find((row) => row.raw['姓名'] === '王五');
  assert.equal(wangwu.status, 'rejected');
  assert.match(wangwu.reason, /单位未映射.*质检组/);
  assert.equal(r.people.has('678'), false);
});

test('异常:编号不是数值的行拒收', () => {
  const r = seeded();
  r.importCsv('编号,姓名,单位\nABC,某人,一车间\n,缺号,一车间\n');
  assert.equal(r.rows.length, 2);
  for (const row of r.rows) {
    assert.equal(row.status, 'rejected');
    assert.match(row.reason, /编号缺失或不是数值编号/);
  }
});

test('异常:空 CSV 与无法识别的表头整批拒收', () => {
  const r = seeded();
  assert.throws(() => r.importCsv(''), /内容为空/);
  assert.throws(() => r.importCsv('工号,名字\n1,甲\n'), /无法识别的表头/);
  assert.equal(r.batches.length, 0); // 整批拒收,不留批次
});

test('身份归一:同一编号在两版交替导入时仍是同一人', () => {
  const r = seeded();
  r.importCsv(V1_CSV); // 123 张三
  r.importCsv(V2_CSV); // 0123 张三
  r.importCsv(V1_CSV); // 123 张三(再次)
  assert.equal(r.people.size, 2); // 张三、李四;王五与赵六未发布
  const p = r.people.get('123');
  assert.equal(p.name, '张三');
  assert.deepEqual(p.versionsSeen, ['v1', 'v2']);
  assert.equal(p.rowIds.length, 3); // 三个来源行归并到同一人
  assert.equal(p.dept, '装配线'); // 新版提供的部门
});

test('旧版再次导入不会清空新版带来的部门', () => {
  const r = seeded();
  r.importCsv(V2_CSV);
  r.importCsv(V1_CSV);
  assert.equal(r.people.get('123').dept, '装配线');
});

test('重跑:修订映射后,已拒收的行按新映射发布并记录来历', () => {
  const r = seeded();
  r.importCsv(V1_CSV);
  let wangwu = r.rows.find((row) => row.raw['姓名'] === '王五');
  assert.equal(wangwu.status, 'rejected');
  assert.equal(wangwu.attempts.length, 1);

  const { mapping, rerun } = r.setMappingAndRerun('质检组', '质量部');
  assert.equal(mapping.revision, 3);
  assert.deepEqual(rerun, { retried: 1, published: 1, stillRejected: 0 });

  wangwu = r.rows.find((row) => row.raw['姓名'] === '王五');
  assert.equal(wangwu.status, 'published');
  assert.equal(wangwu.unit, '质量部');
  assert.equal(wangwu.mapping.revision, 3);
  assert.equal(wangwu.attempts.length, 2); // 导入一次 + 重跑一次
  assert.equal(wangwu.attempts[0].result, 'rejected');
  assert.equal(wangwu.attempts[1].result, 'published');
  assert.equal(r.people.get('678').unit, '质量部');
});

test('重跑:映射仍不可解释的行保持拒收,可再次重跑', () => {
  const r = seeded();
  r.importCsv(V2_CSV); // 赵六(运输队)被拒
  const first = r.rerunRejected();
  assert.deepEqual(first, { retried: 1, published: 0, stillRejected: 1 });
  r.setMapping('运输队', '物流部');
  const second = r.rerunRejected();
  assert.deepEqual(second, { retried: 1, published: 1, stillRejected: 0 });
  const zhaoliu = r.rows.find((row) => row.raw['姓名'] === '赵六');
  assert.equal(zhaoliu.attempts.length, 3);
});

test('已发布的行不因后续映射修订而回溯改写', () => {
  const r = seeded();
  r.importCsv(V1_CSV);
  const zhangsan = r.rows.find((row) => row.raw['姓名'] === '张三');
  assert.equal(zhangsan.unit, '制造一部');
  r.setMapping('一车间', '制造总厂'); // 修订已有映射
  r.rerunRejected();
  assert.equal(zhangsan.unit, '制造一部'); // 已发布行保持原样
  assert.equal(zhangsan.mapping.revision, 1); // 来历里仍是当时的修订号
});

test('异常:映射的原始或目标单位为空被拒绝', () => {
  const r = new Registry();
  assert.throws(() => r.setMapping('', '质量部'), /原始单位不能为空/);
  assert.throws(() => r.setMapping('质检组', ' '), /目标单位不能为空/);
});

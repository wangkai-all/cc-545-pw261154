'use strict';

const { parseCsv } = require('./csv');

const REQUIRED_COLUMNS = ['编号', '姓名', '单位'];

// 接收进程第一步:辨版本。
// 旧版 v1: 编号 / 姓名 / 单位;新版 v2: 单位与部门拆开,多一列「部门」。
function detectVersion(header) {
  const cols = header.map((h) => String(h).trim());
  const hasAll = REQUIRED_COLUMNS.every((c) => cols.includes(c));
  if (!hasAll) return null;
  return cols.includes('部门') ? 'v2' : 'v1';
}

// 身份归一:同一编号在旧版是数值(123)、在新版是保留前导零的字符串(0123),
// 统一去掉前导零作为人员主键,避免交替导入时认成两人。非纯数字视为异常。
function normalizePersonId(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!/^\d+$/.test(t)) return null;
  return t.replace(/^0+(?=\d)/, '');
}

class Registry {
  constructor() {
    this.mappings = new Map(); // 原始单位 -> { alias, canonical, revision, updatedAt }
    this.mappingRevision = 0; // 全局映射修订号,每次新增/修订 +1
    this.batches = [];
    this.rows = []; // 行级记录(含来历)
    this.people = new Map(); // 归一后的人员名册: personId -> person
    this._batchSeq = 0;
    this._rowSeq = 0;
  }

  // 新增或修订一处映射。
  setMapping(alias, canonical) {
    const a = String(alias == null ? '' : alias).trim();
    const c = String(canonical == null ? '' : canonical).trim();
    if (!a) throw Object.assign(new Error('映射的原始单位不能为空'), { code: 'BAD_MAPPING' });
    if (!c) throw Object.assign(new Error('映射的目标单位不能为空'), { code: 'BAD_MAPPING' });
    this.mappingRevision += 1;
    const mapping = {
      alias: a,
      canonical: c,
      revision: this.mappingRevision,
      updatedAt: new Date().toISOString(),
    };
    this.mappings.set(a, mapping);
    return mapping;
  }

  // 接收 + 转换:先辨版本,再逐行走映射,可解释才发布,否则拒收。
  importCsv(text, sourceName = '') {
    const table = parseCsv(text);
    if (table.length === 0) {
      throw Object.assign(new Error('CSV 内容为空'), { code: 'EMPTY_CSV' });
    }
    const header = table[0].map((h) => String(h).trim());
    const version = detectVersion(header);
    if (!version) {
      throw Object.assign(new Error(`无法识别的表头: ${header.join(',')}`), {
        code: 'UNKNOWN_HEADER',
      });
    }
    const batch = {
      id: `B${++this._batchSeq}`,
      version,
      sourceName,
      header,
      receivedAt: new Date().toISOString(),
      total: 0,
      published: 0,
      rejected: 0,
    };
    this.batches.push(batch);

    const records = [];
    for (let i = 1; i < table.length; i++) {
      const fields = table[i];
      if (fields.every((f) => String(f).trim() === '')) continue; // 跳过空行
      batch.total += 1;
      const raw = {};
      header.forEach((col, idx) => {
        raw[col] = String(fields[idx] == null ? '' : fields[idx]).trim();
      });
      const rec = this._newRow(batch, i + 1, raw);
      this._process(rec);
      if (rec.status === 'published') batch.published += 1;
      else batch.rejected += 1;
      records.push(rec);
    }
    return { batch, records };
  }

  _newRow(batch, lineNo, raw) {
    const rec = {
      id: `R${++this._rowSeq}`,
      batchId: batch.id,
      version: batch.version,
      lineNo, // 在源文件中的行号(含表头)
      raw, // 原始各列值,保留前导零等原始形态
      status: 'pending',
      reason: null,
      personId: null,
      unit: null, // 映射后的目标单位
      dept: null,
      mapping: null, // 发布时使用的映射快照 { alias, canonical, revision }
      attempts: [], // 每次处理尝试(导入/重跑)的来历
    };
    this.rows.push(rec);
    return rec;
  }

  // 转换进程:映射可解释才发布,否则拒收并写明原因。
  _process(rec) {
    const attempt = { at: new Date().toISOString(), mappingRevision: this.mappingRevision };

    const personId = normalizePersonId(rec.raw['编号']);
    if (personId === null) {
      rec.status = 'rejected';
      rec.reason = `编号缺失或不是数值编号: 「${rec.raw['编号'] == null ? '' : rec.raw['编号']}」`;
      attempt.result = 'rejected';
      attempt.reason = rec.reason;
      rec.attempts.push(attempt);
      return rec;
    }

    const unitRaw = String(rec.raw['单位'] == null ? '' : rec.raw['单位']).trim();
    const mapping = this.mappings.get(unitRaw);
    if (!mapping) {
      rec.status = 'rejected';
      rec.reason = `单位未映射: 「${unitRaw}」`;
      attempt.result = 'rejected';
      attempt.reason = rec.reason;
      rec.attempts.push(attempt);
      return rec;
    }

    rec.status = 'published';
    rec.reason = null;
    rec.personId = personId;
    rec.unit = mapping.canonical;
    // 保留原列:统一超集结构,旧版行部门为空;旧版导入不覆盖新版已提供的部门。
    rec.dept = rec.version === 'v2' ? String(rec.raw['部门'] == null ? '' : rec.raw['部门']) : '';
    rec.mapping = { alias: mapping.alias, canonical: mapping.canonical, revision: mapping.revision };
    attempt.result = 'published';
    rec.attempts.push(attempt);
    this._upsertPerson(rec, attempt.at);
    return rec;
  }

  _upsertPerson(rec, at) {
    let p = this.people.get(rec.personId);
    if (!p) {
      p = {
        personId: rec.personId,
        name: '',
        unit: '',
        dept: '',
        versionsSeen: [],
        rowIds: [],
        firstSeen: at,
        lastSeen: at,
      };
      this.people.set(rec.personId, p);
    }
    p.name = rec.raw['姓名'] || p.name;
    p.unit = rec.unit;
    if (rec.version === 'v2') p.dept = rec.dept; // 旧版没有部门列,不回填空值
    if (!p.versionsSeen.includes(rec.version)) p.versionsSeen.push(rec.version);
    if (!p.rowIds.includes(rec.id)) p.rowIds.push(rec.id);
    p.lastSeen = at;
    return p;
  }

  // 已拒收的行按当前映射重跑;已发布的行不回溯(来历里保留当时的映射修订号)。
  rerunRejected() {
    const targets = this.rows.filter((r) => r.status === 'rejected');
    let published = 0;
    for (const rec of targets) {
      this._process(rec);
      if (rec.status === 'published') published += 1;
    }
    return { retried: targets.length, published, stillRejected: targets.length - published };
  }

  // 修订一处映射并立即重跑拒收行。
  setMappingAndRerun(alias, canonical) {
    const mapping = this.setMapping(alias, canonical);
    const rerun = this.rerunRejected();
    return { mapping, rerun };
  }

  getRow(id) {
    return this.rows.find((r) => r.id === id) || null;
  }

  getBatch(id) {
    return this.batches.find((b) => b.id === id) || null;
  }

  state() {
    return {
      mappings: [...this.mappings.values()],
      mappingRevision: this.mappingRevision,
      batches: this.batches,
      rows: this.rows,
      people: [...this.people.values()],
      stats: {
        batches: this.batches.length,
        rows: this.rows.length,
        published: this.rows.filter((r) => r.status === 'published').length,
        rejected: this.rows.filter((r) => r.status === 'rejected').length,
        people: this.people.size,
      },
    };
  }
}

module.exports = { Registry, detectVersion, normalizePersonId };

'use strict';

// 小工具:创建带文本的节点,避免把 CSV 数据拼进 HTML。
function el(tag, text, attrs) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (attrs) for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json();
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败(${res.status})`);
  }
  return data;
}

function postJson(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setMessage(id, text, isError) {
  const node = document.getElementById(id);
  node.textContent = text;
  node.classList.toggle('error', Boolean(isError));
}

function fillTable(tableId, rows) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.textContent = '';
  for (const cells of rows) {
    const tr = el('tr');
    for (const cell of cells) {
      tr.appendChild(cell instanceof Node ? el('td').appendChild(cell).parentNode : el('td', cell));
    }
    tbody.appendChild(tr);
  }
}

async function refreshState() {
  const state = await api('/api/state');

  // 映射表
  fillTable(
    'mapping-table',
    state.mappings.map((m) => [m.alias, m.canonical, String(m.revision), m.updatedAt])
  );

  // 业务结果区(data-evidence-result)内的统计
  const stats = document.getElementById('stats');
  stats.textContent =
    `批次 ${state.stats.batches} · 数据行 ${state.stats.rows} · ` +
    `已发布 ${state.stats.published} · 已拒收 ${state.stats.rejected} · 归并后人员 ${state.stats.people}`;

  // 人员名册:同一编号(如 123 / 0123)只出现一次
  fillTable(
    'people-table',
    state.people.map((p) => [
      p.personId,
      p.name,
      p.unit,
      p.dept || '(旧版未提供)',
      p.versionsSeen.join(' + '),
      p.rowIds.join(', '),
    ])
  );

  // 行级处理结果,点击任意行查看来历
  const tbody = document.querySelector('#rows-table tbody');
  tbody.textContent = '';
  for (const r of state.rows) {
    const tr = el('tr');
    tr.dataset.rowId = r.id;
    tr.classList.add(r.status);
    const cells = [
      r.id,
      r.batchId,
      r.version,
      String(r.lineNo),
      r.raw['编号'] || '',
      r.raw['姓名'] || '',
      r.status === 'published' ? '已发布' : '已拒收',
      r.status === 'published'
        ? `单位映射:${r.mapping.alias} → ${r.mapping.canonical}(修订 ${r.mapping.revision})`
        : r.reason,
    ];
    for (const c of cells) tr.appendChild(el('td', c));
    tr.addEventListener('click', () => showProvenance(r.id));
    tbody.appendChild(tr);
  }
}

async function showProvenance(rowId) {
  const box = document.getElementById('provenance-detail');
  try {
    const { row, batch } = await api(`/api/rows/${encodeURIComponent(rowId)}`);
    box.textContent = '';
    box.appendChild(el('h3', `行 ${row.id} 的来历`));
    const facts = [
      ['来源批次', `${batch.id}(${batch.version}版,${batch.sourceName || '未命名'},接收于 ${batch.receivedAt})`],
      ['源文件行号', String(row.lineNo)],
      ['原始各列', JSON.stringify(row.raw)],
      ['归一编号', row.personId || '(未通过编号校验)'],
      ['当前状态', row.status === 'published' ? '已发布' : `已拒收:${row.reason}`],
      [
        '发布所用映射',
        row.mapping ? `${row.mapping.alias} → ${row.mapping.canonical}(修订 ${row.mapping.revision})` : '(尚未发布)',
      ],
    ];
    const dl = el('dl');
    for (const [k, v] of facts) {
      dl.appendChild(el('dt', k));
      dl.appendChild(el('dd', v));
    }
    box.appendChild(dl);
    box.appendChild(el('h4', '处理尝试记录'));
    const ul = el('ul');
    for (const a of row.attempts) {
      ul.appendChild(
        el('li', `${a.at} · 映射修订号 ${a.mappingRevision} · ${a.result === 'published' ? '发布' : `拒收(${a.reason})`}`)
      );
    }
    box.appendChild(ul);
  } catch (err) {
    box.textContent = `查看来历失败:${err.message}`;
  }
}

async function importOne(textareaId, name) {
  const csv = document.getElementById(textareaId).value;
  const { batch } = await postJson('/api/import', { csv, name });
  return `批次 ${batch.id}(${batch.version}):共 ${batch.total} 行,发布 ${batch.published},拒收 ${batch.rejected}`;
}

async function onImport(textareaId, name) {
  try {
    const msg = await importOne(textareaId, name);
    setMessage('import-message', msg, false);
  } catch (err) {
    setMessage('import-message', `导入失败:${err.message}`, true);
  }
  await refreshState();
}

async function onImportBoth() {
  // 交替导入:旧 → 新 → 旧,验证同一编号不会被认成两人
  const messages = [];
  try {
    messages.push(await importOne('csv-v1', '旧版导出'));
    messages.push(await importOne('csv-v2', '新版导出'));
    messages.push(await importOne('csv-v1', '旧版导出(再次)'));
    setMessage('import-message', messages.join(';'), false);
  } catch (err) {
    messages.push(`导入失败:${err.message}`);
    setMessage('import-message', messages.join(';'), true);
  }
  await refreshState();
}

async function onSaveMapping() {
  const alias = document.getElementById('map-alias').value;
  const canonical = document.getElementById('map-canonical').value;
  try {
    const { mapping, rerun } = await postJson('/api/mappings', { alias, canonical });
    setMessage(
      'mapping-message',
      `映射已保存:${mapping.alias} → ${mapping.canonical}(修订 ${mapping.revision});` +
        `重跑拒收行 ${rerun.retried} 条,新发布 ${rerun.published},仍拒收 ${rerun.stillRejected}`,
      false
    );
  } catch (err) {
    setMessage('mapping-message', `保存失败:${err.message}`, true);
  }
  await refreshState();
}

document.getElementById('btn-import-v1').addEventListener('click', () => onImport('csv-v1', '旧版导出'));
document.getElementById('btn-import-v2').addEventListener('click', () => onImport('csv-v2', '新版导出'));
document.getElementById('btn-import-both').addEventListener('click', onImportBoth);
document.getElementById('btn-save-mapping').addEventListener('click', onSaveMapping);

refreshState().catch((err) => setMessage('import-message', `加载状态失败:${err.message}`, true));

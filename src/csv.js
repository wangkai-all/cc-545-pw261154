'use strict';

// 解析 CSV 文本为二维数组。支持引号包裹字段、引号内逗号/换行、双引号转义、CRLF、BOM。
function parseCsv(text) {
  if (typeof text !== 'string') {
    throw new TypeError('CSV 内容必须是字符串');
  }
  const s = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let started = false; // 当前行是否已有任何内容(用于忽略文件末尾空行)

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      started = true;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      started = true;
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
      continue;
    }
    field += c;
    started = true;
  }
  if (inQuotes) {
    const err = new Error('CSV 引号未闭合');
    err.code = 'CSV_UNCLOSED_QUOTE';
    throw err;
  }
  if (started || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

module.exports = { parseCsv };

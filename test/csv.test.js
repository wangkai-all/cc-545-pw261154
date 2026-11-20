'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../src/csv');

test('解析基本 CSV 行与列', () => {
  assert.deepEqual(parseCsv('a,b,c\n1,2,3\n'), [
    ['a', 'b', 'c'],
    ['1', '2', '3'],
  ]);
});

test('引号字段内允许逗号、换行与双引号转义', () => {
  assert.deepEqual(parseCsv('x,y\n"一,二","三""四"\n"多\n行",z'), [
    ['x', 'y'],
    ['一,二', '三"四'],
    ['多\n行', 'z'],
  ]);
});

test('兼容 CRLF 与 BOM', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n1,2\r\n'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('末尾无换行也能收尾,末尾空行被忽略', () => {
  assert.deepEqual(parseCsv('a,b\n1,2'), [
    ['a', 'b'],
    ['1', '2'],
  ]);
  assert.deepEqual(parseCsv('a,b\n1,2\n\n'), [
    ['a', 'b'],
    ['1', '2'],
    [''],
  ]);
});

test('引号未闭合属于异常', () => {
  assert.throws(() => parseCsv('a,b\n"未闭合,2'), /引号未闭合/);
});

test('非字符串输入属于异常', () => {
  assert.throws(() => parseCsv(null), TypeError);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import test from 'node:test';
import { stockAliasStatements } from './lib/knowledge-stock-alias-statements.mjs';

const migration = readFileSync(resolve('migrations/0143_stock_alias_identity.sql'), 'utf8');
const renameMigration = readFileSync(resolve('migrations/0144_rename_stock_alias_tables.sql'), 'utf8');

test('stock alias migration keeps one short name per code and case-insensitive alias candidates', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE knowledge_stock_aliases (
        alias TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT, source TEXT, updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_knowledge_stock_aliases_code ON knowledge_stock_aliases(code);
      INSERT INTO knowledge_stock_aliases VALUES
        ('300750.sz','300750.SZ','宁德时代','target',10),
        ('宁德时代','300750.SZ','宁德时代','target',10),
        ('CATL','300750.SZ','旧简称','doc_metadata',20),
        ('苹果','AAPL.US','苹果','target',10),
        ('苹果公司','AAPL.US','苹果','doc_metadata',20),
        ('苹果集团','9999.HK','苹果集团','target',10);`);
    db.exec(migration);
    db.exec(renameMigration);
    assert.deepEqual(db.prepare('SELECT code,short_name FROM stock ORDER BY code').all().map((row) => ({ ...row })), [
      { code: '300750.SZ', short_name: '宁德时代' },
      { code: '9999.HK', short_name: '苹果集团' },
      { code: 'AAPL.US', short_name: '苹果' },
    ]);
    db.prepare(`INSERT INTO stock_alias (alias,code,source,updated_at)
      VALUES ('苹果','9999.HK','manual',30)`).run();
    assert.deepEqual(db.prepare(`SELECT a.code,s.short_name AS name FROM stock_alias a
      JOIN stock s ON s.code=a.code WHERE a.alias=lower(trim(?)) ORDER BY a.code`).all(' 苹果 ').map((row) => ({ ...row })), [
      { code: '9999.HK', name: '苹果集团' },
      { code: 'AAPL.US', name: '苹果' },
    ]);
    assert.throws(() => db.prepare(`INSERT INTO stock_alias VALUES ('300750.SZ','300750.SZ','manual',30)`).run(), /CHECK constraint/);
    assert.throws(() => db.prepare(`INSERT INTO stock_alias VALUES ('unknown','NOPE.US','manual',30)`).run(), /FOREIGN KEY constraint/);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('knowledge importer writes canonical names once and deduplicates case variants', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE knowledge_stock_aliases (
        alias TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT, source TEXT, updated_at INTEGER NOT NULL
      );`);
    db.exec(migration);
    db.exec(renameMigration);
    const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
    db.exec(stockAliasStatements([
      { alias: '300750.SZ', code: '300750.SZ', name: '宁德时代', source: 'target' },
      { alias: '300750.sz', code: '300750.SZ', name: '宁德时代', source: 'doc_metadata' },
      { alias: '宁德时代', code: '300750.SZ', name: '宁德时代', source: 'target' },
      { alias: 'NOPE.US', code: 'NOPE.US', name: '', source: 'doc_metadata' },
    ], 10, quote).join('\n'));
    assert.equal(db.prepare('SELECT count(*) AS n FROM stock').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM stock_alias').get().n, 2);
    assert.equal(db.prepare("SELECT short_name FROM stock WHERE code='300750.SZ'").get().short_name, '宁德时代');
    db.exec(stockAliasStatements([
      { alias: 'CATL', code: '300750.SZ', name: '较旧名称', source: 'doc_metadata' },
    ], 9, quote).join('\n'));
    assert.equal(db.prepare("SELECT short_name FROM stock WHERE code='300750.SZ'").get().short_name, '宁德时代');
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

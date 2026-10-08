import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSqliteWorkspace} from '../lib/sqlite-workspace.mjs';

async function fixture(t) {
  const directory=await mkdtemp(join(tmpdir(),'chill-sqlite-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));return directory;
}

test('SQLite persists IDs and indexed change cursors across connections; isolates projects',async t=>{
  const dir=await fixture(t),other=await fixture(t);
  const store=await openSqliteWorkspace(dir);
  store.transaction(db=>{
    db.prepare('INSERT INTO goals VALUES (?,?,?)').run(12,null,'{"id":"12"}');
    db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(27,41,12,'{"text":"こんにちは"}');
    db.prepare('INSERT INTO briefs VALUES (?,?,?)').run(12,8,'{"body":"scene"}');
  });
  store.close();
  const reopened=await openSqliteWorkspace(dir),isolated=await openSqliteWorkspace(other);
  try {
    assert.equal(reopened.db.prepare('SELECT body FROM events WHERE goal_id=? AND change_id>?').get(12,40).body,'{"text":"こんにちは"}');
    assert.equal(reopened.db.prepare('SELECT version FROM briefs WHERE goal_id=?').get(12).version,8);
    assert.equal(isolated.db.prepare('SELECT count(*) AS n FROM goals').get().n,0);
    assert.match(reopened.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM events WHERE goal_id=12 AND change_id>40').get().detail,/events_goal_change/);
  } finally {reopened.close();isolated.close();}
});

test('failed transactions do not leave partial records; foreign keys and change IDs are enforced',async t=>{
  const store=await openSqliteWorkspace(await fixture(t));t.after(()=>store.close());
  assert.throws(()=>store.transaction(db=>{
    db.prepare('INSERT INTO goals VALUES (1,NULL,?)').run('{}');
    db.prepare('INSERT INTO events VALUES (1,1,99,?)').run('{}');
  }),/FOREIGN KEY/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM goals').get().n,0);
  store.transaction(db=>db.prepare('INSERT INTO goals VALUES (1,NULL,?)').run('{}'));
  store.db.prepare('INSERT INTO events VALUES (1,1,1,?)').run('{}');
  assert.throws(()=>store.db.prepare('INSERT INTO events VALUES (2,1,1,?)').run('{}'),/UNIQUE/);
  assert.throws(()=>store.transaction(async()=>{}),/synchronous/);
  assert.throws(()=>store.transaction(db=>{db.prepare('INSERT INTO goals VALUES (2,NULL,?)').run('{}');return Promise.resolve();}),/Promise/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM goals').get().n,1);
});

test('legacy and future stores are rejected without silently initializing or downgrading',async t=>{
  const legacy=await fixture(t);
  await writeFile(join(legacy,'schema.json'),'existing-data');
  await assert.rejects(openSqliteWorkspace(legacy),/explicit migration/);
  await assert.rejects(readFile(join(legacy,'workspace.sqlite')), {code:'ENOENT'});
  const dir=await fixture(t),store=await openSqliteWorkspace(dir);
  store.db.exec('PRAGMA user_version=99');store.close();
  const before=await readFile(join(dir,'workspace.sqlite'));
  await assert.rejects(openSqliteWorkspace(dir),/Unsupported/);
  assert.deepEqual(await readFile(join(dir,'workspace.sqlite')),before);
});

test('unrelated SQLite databases are not adopted',async t=>{
  const {DatabaseSync}=await import('node:sqlite');
  const dir=await fixture(t),path=join(dir,'workspace.sqlite');
  const db=new DatabaseSync(path);db.exec('CREATE TABLE unrelated(value TEXT)');db.close();
  const before=await readFile(path);
  await assert.rejects(openSqliteWorkspace(dir),/Unsupported/);
  assert.deepEqual(await readFile(path),before);
});

test('independent processes serialize writes without losing committed rows',async t=>{
  const {spawn}=await import('node:child_process');
  const dir=await fixture(t),store=await openSqliteWorkspace(dir);store.close();
  const url=new URL('../lib/sqlite-workspace.mjs',import.meta.url).href;
  const run=offset=>new Promise((resolve,reject)=>{
    const source=`import {openSqliteWorkspace} from ${JSON.stringify(url)};
      const s=await openSqliteWorkspace(${JSON.stringify(dir)});
      for(let i=1;i<=20;i++)s.transaction(db=>db.prepare('INSERT INTO goals VALUES (?,NULL,?)').run(i+${offset},'{}'));
      s.close();`;
    const child=spawn(process.execPath,['--input-type=module','-e',source]);let error='';
    child.stderr.on('data',chunk=>error+=chunk);child.on('error',reject);
    child.on('exit',code=>code===0?resolve():reject(Error(error||`exit ${code}`)));
  });
  await Promise.all([run(0),run(20)]);
  const reopened=await openSqliteWorkspace(dir);
  try {assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM goals').get().n,40);}
  finally {reopened.close();}
});

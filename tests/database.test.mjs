import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const migration = new URL('../supabase/migrations/20261108000100_crm.sql', import.meta.url);
const manager = '00000000-0000-4000-8000-000000000001';
const workerA = '00000000-0000-4000-8000-000000000002';
const workerB = '00000000-0000-4000-8000-000000000003';
let siteA, siteB, taskA, taskB;

async function as(user, run) {
  return db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    return run(tx);
  });
}

function transition(user, task, status, note = null) {
  return as(user, (tx) => tx.query('select public.transition_task($1, $2, $3)', [task, status, note]));
}

before(async () => {
  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
    alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
  `);
  await db.exec(await readFile(migration, 'utf8'));
  await db.query('insert into auth.users values ($1), ($2), ($3)', [manager, workerA, workerB]);
  await db.query("insert into profiles values ($1, 'Manager', 'manager'), ($2, 'Worker A', 'worker'), ($3, 'Worker B', 'worker')", [manager, workerA, workerB]);

  await as(manager, async (tx) => {
    const sites = await tx.query("insert into sites(name,address) values ('Site A','Address A'), ('Site B','Address B') returning id");
    [siteA, siteB] = sites.rows.map((row) => row.id);
    const tasks = await tx.query("insert into tasks(site_id,title,assignee_id) values ($1,'Task A',$2), ($3,'Task B',$4) returning id", [siteA, workerA, siteB, workerB]);
    [taskA, taskB] = tasks.rows.map((row) => row.id);
  });
});

after(() => db.close());

test('workers can only read their own tasks, related sites and history', async () => {
  for (const [user, task, site] of [[workerA, taskA, siteA], [workerB, taskB, siteB]]) {
    await as(user, async (tx) => {
      assert.deepEqual((await tx.query('select id from tasks')).rows, [{ id: task }]);
      assert.deepEqual((await tx.query('select id from sites')).rows, [{ id: site }]);
      assert.deepEqual((await tx.query('select task_id from task_history')).rows, [{ task_id: task }]);
      const names = (await tx.query('select id from profiles')).rows.map((row) => row.id).sort();
      assert.deepEqual(names, [manager, user].sort());
    });
  }
});

test('direct writes cannot alter roles, attribution, status or history', async () => {
  await assert.rejects(as(workerA, (tx) => tx.query("update profiles set role = 'manager' where id = $1", [workerA])), { code: '42501' });
  await assert.rejects(as(workerA, (tx) => tx.query("insert into tasks(site_id,title,assignee_id) values ($1,'Fake',$2)", [siteA, workerA])), { code: '42501' });
  await assert.rejects(as(manager, (tx) => tx.query("update tasks set status = 'accepted' where id = $1", [taskA])), { code: '42501' });
  await assert.rejects(as(manager, (tx) => tx.query('update tasks set author_id = $1 where id = $2', [workerA, taskA])), { code: '42501' });
  const reassigned = await as(workerA, (tx) => tx.query('update tasks set assignee_id = $1 where id = $2 returning id', [workerA, taskB]));
  assert.deepEqual(reassigned.rows, []);
  const ownUpdate = await as(workerA, (tx) => tx.query("update tasks set title = 'Fake' where id = $1 returning id", [taskA]));
  assert.deepEqual(ownUpdate.rows, []);
  for (const sql of [
    "insert into task_history(task_id,actor_id,to_status) values ($1,$2,'accepted')",
    "update task_history set comment = 'Fake' where task_id = $1 and actor_id = $2",
    "delete from task_history where task_id = $1 and actor_id = $2",
  ]) {
    for (const user of [manager, workerA]) {
      await assert.rejects(as(user, (tx) => tx.query(sql, [taskA, manager])), { code: '42501' });
    }
  }
});

test('database enforces the whole task workflow and records only successful actions', async () => {
  await assert.rejects(transition(workerB, taskA, 'in_progress'), { code: '42501' });
  await assert.rejects(transition(workerA, taskA, 'review'), { code: '22023' });
  await assert.rejects(transition(manager, taskA, 'in_progress'), { code: '22023' });
  await transition(workerA, taskA, 'in_progress');
  await transition(workerA, taskA, 'review', 'Готово');
  await assert.rejects(transition(workerA, taskA, 'accepted'), { code: '22023' });
  await assert.rejects(transition(manager, taskA, 'revision', ' \t\n '), { code: '22023' });
  await transition(manager, taskA, 'revision', 'Проверить крепление');
  await transition(workerA, taskA, 'in_progress');
  await transition(workerA, taskA, 'review');
  await transition(manager, taskA, 'accepted');
  await assert.rejects(transition(manager, taskA, 'revision', 'Повтор'), { code: '22023' });
  await as(workerA, async (tx) => {
    const history = await tx.query('select actor_id,from_status,to_status,comment from task_history where task_id=$1 order by id', [taskA]);
    assert.deepEqual(history.rows, [
      { actor_id: manager, from_status: null, to_status: 'new', comment: null },
      { actor_id: workerA, from_status: 'new', to_status: 'in_progress', comment: null },
      { actor_id: workerA, from_status: 'in_progress', to_status: 'review', comment: 'Готово' },
      { actor_id: manager, from_status: 'review', to_status: 'revision', comment: 'Проверить крепление' },
      { actor_id: workerA, from_status: 'revision', to_status: 'in_progress', comment: null },
      { actor_id: workerA, from_status: 'in_progress', to_status: 'review', comment: null },
      { actor_id: manager, from_status: 'review', to_status: 'accepted', comment: null },
    ]);
  });
});

test('only managers can archive and archive preserves the stored history', async () => {
  await assert.rejects(as(workerB, (tx) => tx.query('select archive_site($1)', [siteB])), { code: '42501' });
  await assert.rejects(as(workerB, (tx) => tx.query('select archive_task($1)', [taskB])), { code: '42501' });
  await as(manager, (tx) => tx.query('select archive_site($1)', [siteB]));
  await assert.rejects(transition(workerB, taskB, 'in_progress'), { code: '42501' });
  await as(workerB, async (tx) => {
    for (const table of ['sites', 'tasks', 'task_history']) {
      assert.deepEqual((await tx.query(`select * from ${table}`)).rows, []);
    }
  });
  assert.equal((await db.query('select * from task_history where task_id=$1', [taskB])).rows.length, 1);
});

test('unauthenticated API role has neither table access nor workflow execution', async () => {
  await assert.rejects(db.transaction(async (tx) => {
    await tx.exec('set local role anon');
    await tx.query('select * from tasks');
  }), { code: '42501' });
  await assert.rejects(db.transaction(async (tx) => {
    await tx.exec('set local role anon');
    await tx.query("select transition_task($1,'in_progress')", [taskA]);
  }), { code: '42501' });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('v7 rollback refuses active v8 work, snapshots current state and retains all completed tasks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'monte-rollback-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'tasks.json');
  const data = { schemaVersion: 2, tasks: [{ schemaVersion: 2, taskId: 'new', status: 'running', purpose: 'consultation', backend: 'work', research: { question: 'where' } }, { schemaVersion: 1, taskId: 'old', status: 'running', backend: 'work' }] };
  await writeFile(path, JSON.stringify(data));
  assert.notEqual(spawnSync('python3', ['deploy/prepare-v7-rollback.py', '--tasks', path]).status, 0);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), data);
  data.tasks[0].status = 'completed'; await writeFile(path, JSON.stringify(data));
  const backup = execFileSync('python3', ['deploy/prepare-v7-rollback.py', '--tasks', path], { encoding: 'utf8' }).trim();
  assert.deepEqual(JSON.parse(await readFile(backup, 'utf8')), data);
  const after = JSON.parse(await readFile(path, 'utf8')); assert.equal(after.schemaVersion, 1); assert.equal(after.tasks.length, 2);
  assert.equal(after.tasks[0].purpose, undefined); assert.equal(after.tasks[0].research, undefined); assert.equal(after.tasks[1].status, 'running');
});

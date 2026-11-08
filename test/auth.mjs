import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodexCredentials } from '../lib/auth.js';

const original = () => ({ auth_mode: 'chatgpt', tokens: { access_token: 'fixture-old', refresh_token: 'fixture-refresh', account_id: 'fixture-account' }, unknown: { keep: true } });
async function fixture(t, writeBack = false, fetchImpl) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-codex-auth-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authFile = path.join(dir, 'auth.json');
  await writeFile(authFile, JSON.stringify(original()));
  const config = { authFile, writeBack, fetch: fetchImpl ?? (async () => Response.json({ access_token: 'fixture-new', refresh_token: 'fixture-rotated' })) };
  return { dir, authFile, config, credentials: new CodexCredentials(() => config) };
}

test('writeBack:false reuses refreshed credentials in memory without changing file', async t => {
  const { authFile, credentials } = await fixture(t);
  const before = await readFile(authFile, 'utf8');
  const refreshed = await credentials.refresh();
  assert.equal(refreshed.accessToken, 'fixture-new');
  assert.equal((await credentials.current()).accessToken, 'fixture-new');
  assert.equal(await readFile(authFile, 'utf8'), before);
});

test('second in-memory refresh uses the rotated refresh token', async t => {
  const sent = [];
  const { credentials } = await fixture(t, false, async (_url, init) => {
    sent.push(init.body.get('refresh_token'));
    return Response.json({ access_token: `fixture-new-${sent.length}`, refresh_token: `fixture-rotated-${sent.length}` });
  });
  await credentials.refresh();
  await credentials.refresh();
  assert.deepEqual(sent, ['fixture-refresh', 'fixture-rotated-1']);
  assert.equal((await credentials.current()).accessToken, 'fixture-new-2');
});

test('changing account, credential path, or logging out invalidates memory credentials', async t => {
  const { authFile, credentials, config, dir } = await fixture(t);
  await credentials.refresh();
  const switched = original();
  switched.tokens.access_token = 'fixture-switched';
  switched.tokens.account_id = 'fixture-other-account';
  await writeFile(authFile, JSON.stringify(switched));
  assert.equal((await credentials.current()).accessToken, 'fixture-switched');
  const otherFile = path.join(dir, 'other.json');
  await writeFile(otherFile, JSON.stringify(original()));
  config.authFile = otherFile;
  assert.equal((await credentials.current()).accessToken, 'fixture-old');
  await rm(otherFile);
  await assert.rejects(credentials.current(), e => e.code === 'MISSING_CREDENTIAL');
});

test('concurrent refresh calls share one request', async t => {
  let count = 0;
  const { credentials } = await fixture(t, false, async () => {
    count += 1;
    await new Promise(resolve => setTimeout(resolve, 10));
    return Response.json({ access_token: 'fixture-new', refresh_token: 'fixture-rotated' });
  });
  const values = await Promise.all([credentials.refresh(), credentials.refresh(), credentials.refresh()]);
  assert.equal(count, 1);
  assert.ok(values.every(value => value.accessToken === 'fixture-new'));
});

test('successful writeback preserves unrelated fields', async t => {
  const { authFile, credentials } = await fixture(t, true);
  await credentials.refresh();
  const result = JSON.parse(await readFile(authFile, 'utf8'));
  assert.equal(result.tokens.access_token, 'fixture-new');
  assert.equal(result.tokens.refresh_token, 'fixture-rotated');
  assert.deepEqual(result.unknown, { keep: true });
  assert.equal(result.tokens.account_id, 'fixture-account');
  assert.equal((await credentials.current()).accessToken, 'fixture-new');
});

test('failed disk writeback retains fresh credentials for this process', async t => {
  const { authFile, credentials } = await fixture(t, true);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  await mkdir(`${authFile}.tmp-${process.pid}-${now}`);
  t.mock.method(console, 'error', () => {});
  const before = await readFile(authFile, 'utf8');
  assert.equal((await credentials.refresh()).accessToken, 'fixture-new');
  assert.equal((await credentials.current()).accessToken, 'fixture-new');
  assert.equal(await readFile(authFile, 'utf8'), before);
});

test('refresh failures propagate and do not poison future refreshes', async t => {
  const { credentials, config } = await fixture(t, false, async () => Response.json({ error: 'fixture-rejected' }, { status: 401 }));
  await assert.rejects(credentials.refresh(), e => e.code === 'AUTH');
  assert.equal((await credentials.current()).accessToken, 'fixture-old');
  config.fetch = async () => Response.json({ access_token: 'fixture-new' });
  assert.equal((await credentials.refresh()).accessToken, 'fixture-new');
});


for (const writeBack of [false, true]) {
  for (const change of ['account', 'path', 'logout']) {
    test('in-flight refresh never overwrites or reuses credentials after ' + change + ' (writeBack:' + writeBack + ')', async t => {
      let release, started;
      const gate = new Promise(resolve => { release = resolve; });
      const begin = new Promise(resolve => { started = resolve; });
      const { authFile, credentials, config, dir } = await fixture(t, writeBack, async () => {
        started();
        await gate;
        return Response.json({ access_token: 'fixture-new', refresh_token: 'fixture-rotated' });
      });
      const refreshing = credentials.refresh();
      await begin;
      const changed = original();
      changed.tokens.access_token = 'fixture-account-b';
      changed.tokens.account_id = 'fixture-account-b';
      if (change === 'account') await writeFile(authFile, JSON.stringify(changed));
      else if (change === 'path') {
        config.authFile = path.join(dir, 'account-b.json');
        await writeFile(config.authFile, JSON.stringify(changed));
      } else await rm(authFile);
      release();
      await assert.rejects(refreshing, e => e.code === (change === 'logout' ? 'MISSING_CREDENTIAL' : 'AUTH_CHANGED'));
      if (change === 'logout') {
        await assert.rejects(credentials.current(), e => e.code === 'MISSING_CREDENTIAL');
      } else {
        assert.equal((await credentials.current()).accessToken, 'fixture-account-b');
        assert.equal(JSON.parse(await readFile(config.authFile, 'utf8')).tokens.access_token, 'fixture-account-b');
      }
    });
  }
}

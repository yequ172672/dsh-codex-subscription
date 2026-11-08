/** Real backend tests use file credentials read-only and never rotate tokens. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function createLiveAdapter(overrides = {}) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Live tests require TLS certificate validation; set NODE_TLS_REJECT_UNAUTHORIZED=1.');
  }
  const root = process.env.CODEX_TEST_PACKAGE_ROOT;
  const moduleUrl = name => root ? pathToFileURL(path.join(root, 'lib', name)) : new URL(`../lib/${name}`, import.meta.url);
  const [{ CodexAdapter }, { CodexCredentials }, { createTransport }, { discoverModelsLive }] = await Promise.all([
    import(moduleUrl('adapter.js')), import(moduleUrl('auth.js')), import(moduleUrl('transport.js')), import(moduleUrl('models.js')),
  ]);
  const config = { streamIdleTimeoutMs: 120_000, proxy: process.env.CODEX_TEST_PROXY, ...overrides, writeBack: false };
  const transport = await createTransport(config);
  const credentials = new CodexCredentials(() => config);
  // A token refresh can rotate the refresh token even with writeBack:false. Do not
  // invalidate the user's saved CLI login as a side effect of an acceptance test.
  credentials.refresh = async () => {
    const error = new Error('Live test received HTTP 401; refresh is disabled. Sign in again through Codex and rerun.');
    error.code = 'AUTH';
    throw error;
  };
  const adapter = new CodexAdapter({ options: () => config, credentials, transport: async () => transport });
  const creds = await credentials.current();
  const catalog = await discoverModelsLive(creds, config.clientVersion, undefined, transport);
  if (!catalog?.length) throw new Error('Live model discovery failed; acceptance tests do not count cached/static fallback as success.');
  return { adapter, credentials, catalog, transport };
}

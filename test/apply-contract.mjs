/**
 * 0.2.0 宿主装载契约测试(离线,不联网)。
 *
 * 模拟 DSH ≥ 44(dsh-llm 0.2.0-rc.2 + cordis loader)对本插件的调用方式:
 *   1. 模块导出形状(name/inject/apply/Config)
 *   2. Config 全字段 volatile(0.2.0 设置页只编辑 volatile 字段,否则
 *      SettingsForms 直接拒绝写入)
 *   3. Config 按 cordis resolveConfig 的方式校验,产出 `.get()` 引用
 *   4. apply() 通过 0.2.0 LlmRuntime 的目录/适配器结构校验
 *      (含 0.2.x 每次调用都会走的 adapter.prepareCall)
 *
 * 用法:node test/apply-contract.mjs
 */

import assert from 'node:assert/strict';

import plugin, { Config, PROVIDER } from '../lib/index.js';

// ① 导出形状
assert.equal(plugin.name, 'llm-codex');
assert.deepEqual(plugin.inject, ['llm']);
assert.equal(typeof plugin.apply, 'function');
assert.equal(plugin.Config, Config);
assert.equal(typeof Config.toJSON, 'function');
assert.equal(PROVIDER, 'codex');

// ② Config 顶层字段必须全部 volatile(schemastery 字段在 `.dict` 上)
assert.equal(typeof Config.toJSON, 'function');
const fields = Object.keys(Config.dict ?? {});
assert.ok(fields.length >= 7, `expected config fields, got ${fields.join(',')}`);
for (const key of fields) {
  assert.equal(Config.dict[key]?.meta?.volatile, true, `config field "${key}" must be volatile`);
}

// ③ 按 cordis resolveConfig 的方式校验 raw config
const validated = Config['~standard'].validate({
  proxy: 'http://127.0.0.1:7890',
  writeBack: false,
});
assert.ok(!validated.issues, JSON.stringify(validated.issues));
const config = validated.value;
assert.equal(typeof config.proxy.get, 'function');
assert.equal(config.proxy.get(), 'http://127.0.0.1:7890');
assert.equal(config.writeBack.get(), false);
assert.equal(config.clientVersion.get(), '0.160.1'); // 默认值经 volatile 引用可见
assert.deepEqual(config.staticModels.get(), []); // 未配置 → 空数组快照(resolveOptions 会当作未设置)

// ④ 模拟 0.2.0 宿主的两处注册校验
const observed = { directory: undefined, adapter: undefined };
const ctx = {
  logger: { error: (...args) => console.error(...args) },
  fiber: { entry: { options: { id: 'llm-codex' } } },
  llm: {
    registerConfigurableProviders(entries) {
      assert.ok(entries.length >= 1);
      for (const entry of entries) {
        // 0.2.0:provider/displayName/settingsNs 非空,settingsPath 无空段
        assert.ok(entry.provider.length > 0);
        assert.ok(entry.displayName.length > 0);
        assert.ok(entry.settingsNs.length > 0);
        assert.ok(Array.isArray(entry.settingsPath));
        assert.ok(!entry.settingsPath.some((segment) => segment.length === 0));
      }
      observed.directory = entries;
      return Object.assign(() => {}, { replace: () => {} });
    },
    registerAdapter(providers, adapter) {
      assert.deepEqual(providers, ['codex']);
      // prepareRoutes 的结构校验
      const info = adapter.providerInfo('codex');
      assert.equal(info.id, 'codex');
      assert.ok(info.name.length > 0);
      assert.equal(adapter.providerRetryPolicy('codex'), undefined);
      // 0.2.x LlmRuntime.prepareCall 每次模型调用都会无条件调用
      assert.equal(typeof adapter.prepareCall, 'function');
      assert.equal(typeof adapter.stream, 'function');
      assert.equal(typeof adapter.listModels, 'function');
      assert.equal(typeof adapter.resolveModel, 'function');
      observed.adapter = adapter;
      return Object.assign(() => {}, { replace: () => {} });
    },
  },
};

plugin.apply(ctx, config);

assert.equal(observed.directory[0].provider, 'codex');
assert.equal(observed.directory[0].settingsNs, 'llm-codex');
assert.deepEqual(observed.directory[0].settingsPath, []);
assert.equal(observed.adapter.providerInfo('codex').name, 'Codex (ChatGPT 订阅)');

console.log('APPLY CONTRACT OK (dsh-llm 0.2.0-rc.2 shape)');

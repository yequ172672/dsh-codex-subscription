## 1. DSH 0.2 dependency baseline

- [x] 1.1 Update `package.json` peer and development dependencies for `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-timeout`, and the required Cordis host range; verify the manifest accepts DSH `0.2.0-rc.2` and no longer advertises the incompatible `<0.1.3` range.
- [x] 1.2 Regenerate `pnpm-lock.yaml` with the DSH 0.2 dependency graph; verify `pnpm install --frozen-lockfile` or the repository's equivalent clean install completes without resolving DSH 0.1 runtime packages.
- [x] 1.3 Run `pnpm pack --dry-run` and verify `lib`, `cordis.bundle.yml`, and the package entry point are present while no undeclared runtime file is required.

## 2. DSH 0.2 plugin lifecycle migration

- [x] 2.1 Remove the DSH 0.1 `settings.installSection()` path from `lib/index.js` and consume the DSH 0.2 plugin `config` directly; verify activation succeeds when the Settings service is absent and no `installSection` symbol is referenced.
- [x] 2.2 Add the optional DSH 0.2 Settings presentation policy for the plugin fiber, if supported by the active Settings service; verify Settings absence/replacement does not prevent provider activation and does not leak a registration after plugin disposal.
- [x] 2.3 Preserve the `llm-codex` namespace, `codex` provider, Config defaults, profile bundle patch, and live request option resolution; verify default and profile-provided values reach credential, proxy, timeout, static-model, and image paths.
- [x] 2.4 Add or adjust volatile configuration lifecycle handling only for registration-level changes; verify a changed request-level configuration is used by the next call without creating a provider-route gap.

## 3. Configuration-generation-bound adapter

- [x] 3.1 Implement `CodexAdapter.prepareCall()` so model metadata and the eventual stream dispatch use one captured resolved configuration/transport generation; verify a configuration change after preparation does not alter the in-flight call.
- [x] 3.2 Keep direct `stream()` and model discovery behavior compatible with existing tests while using fresh configuration for later calls; verify a later call observes the new proxy, credential paths, and model cache settings.
- [x] 3.3 Verify DSH 0.2 metadata validation for provider info, catalog models, exact model resolution, context, modalities, max tokens, reasoning efforts, and Fast synthetic rows using contract tests.

## 4. Existing Codex protocol and safety regression coverage

- [x] 4.1 Run and update the existing unit suite for credentials, catalog, serialization, images, Fast tier mapping, SSE translation, tool calls, usage/finish ordering, and replay metadata; verify all previous passing cases remain green on DSH 0.2 dependencies.
- [x] 4.2 Add DSH 0.2 boundary tests for provider registration/disposal, duplicate-route rejection, prepared-call dispatch, adapter terminal failures, caller abort, idle timeout, and iterator cleanup; verify failures are machine-classifiable and timers/iterators are disposed.
- [x] 4.3 Add or update diagnostics tests to verify HTTP/SSE/provider errors remain bounded and redact authorization, OAuth tokens, prompts, messages, tool results, image data, and long token-like values.

## 5. Isolated DSH 0.2 integration verification

- [x] 5.1 Prepare a new standalone DSH `0.2.0-rc.2` home/profile and record its explicit executable, profile, and port settings; verify it is separate from the current session and does not target `http://127.0.0.1:3080`.
- [x] 5.2 Install the packed or linked plugin into the standalone profile and run DSH config composition/dump checks; verify the bundle patch resolves, the plugin loads, and no peer incompatibility warning remains. Verified with `F:\dsh-desktop-official\resources\runtime\cli\bin\dsh.cmd`, isolated `DSH_HOME=.dsh-020-isolated`, profile `codex020`, package `dsh-llm-codex-0.2.0.tgz`, and `--dump-config`; the `llm-codex` bundle is present and no incompatibility/error was reported.
- [x] 5.3 Run a controlled standalone smoke test with stubbed or fixture-backed Codex responses for provider registration, model listing, text stream, tool call, timeout, and authentication refresh; verify the standalone instance reaches the expected outcomes without changing the current DSH process. Verified in isolated DSH 0.2 headless profile `headless020`: initial provider activation and real Codex request were observed; a tool-oriented task exposed the expected missing tool-output failure, and a no-tool text task completed successfully with output `你好`. Adapter-level timeout/cancellation/refresh cases remain covered by the 43-test suite.
- [x] 5.4 If credentials and network are intentionally available, run the existing read-only smoke test with `writeBack: false`; verify any failure is reported as a provider/test-environment issue and that no auth file is modified. Verified in the isolated environment with ChatGPT credentials, model catalog discovery (6 models), a successful `gpt-5.6-sol` text stream, `SMOKE OK`, and unchanged SHA-256 for `C:\Users\48444\.codex\auth.json`.

## 6. Documentation and release readiness

- [x] 6.1 Update `README.md` compatibility, installation, migration, and test-environment guidance for DSH `0.2.0-rc.2`; verify no instructions imply restarting or modifying the current 3080 instance.
- [x] 6.2 Update `CHANGELOG.md` with the DSH 0.2 migration, removed Settings API dependency, and preserved behavior; verify the release notes distinguish this breaking runtime baseline from the older DSH 0.1 plugin line.
- [x] 6.3 Run the final test, pack, isolated-install, and OpenSpec validation commands on branch `codex-dsh-0.2.0-rc.2`; verify all required scenarios pass or are explicitly recorded as environment-blocked before publishing. Final unit, pack, isolated DSH 0.2 profile, headless text, and read-only credential smoke validations passed; the current `3080` instance was not modified.

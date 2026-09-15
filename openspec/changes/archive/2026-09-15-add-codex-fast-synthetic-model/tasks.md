## 1. Protocol facts and pure mapping foundation

- [x] 1.1 Freeze and record the implementation's protocol evidence versions (OpenAI Fast documentation revision/date, Codex commits `7c0e54bf592bc12ef5ab14531b9732df4fc3803e` and `317213fd33fcbc76ae59817f9188033bb3569383`, DSH `0.1.2-rc.1`) without changing `clientVersion`; verify the record appears in change notes/release notes and no real Codex request is made.
- [x] 1.2 Add a small dependency-free service-tier/picker mapping module with `-fast` parsing, `priority` constant, explicit unknown-ID behavior, and immutable body projection; verify unit tests cover ordinary, known Fast, unknown ordinary, unknown Fast, repeated suffix, and no picker-ID leakage.
- [x] 1.3 Extend safe request diagnostics allowlists with only picker/wire model and requested tier facts as needed; verify diagnostics never contain prompts, messages, tool results, images, OAuth tokens, or complete request bodies.

## 2. Catalog normalization and capability inheritance

- [x] 2.1 Extend live `/codex/models`, `models_cache.json`, explicit static models, and built-in entry decoding to preserve `description`, `service_tiers` (`id/name/description`), legacy `additional_speed_tiers`, and existing context/max/reasoning/input fields; verify fixtures from all three source classes parse without network access.
- [x] 2.2 Implement capability detection that prefers exact `service_tiers[].id === "priority"`, falls back to exact legacy `additional_speed_tiers` value `"fast"`, and rejects name-only/unknown tiers such as `ultrafast`; verify positive and negative catalog tests.
- [x] 2.3 Normalize source entries and derive at most one `<base-id>-fast` row per base wire ID, including pre-suffixed input, stable de-duplication, display-name/description rules, and full capability inheritance; verify list order and duplicate tests.
- [x] 2.4 Keep ordinary static/builtin behavior unchanged and document that unknown explicit Fast IDs map but are not auto-advertised; verify existing catalog tests and new unknown-model tests.

## 3. Adapter integration without DSH core changes

- [x] 3.1 Update `listModels()` to expose ordinary and synthetic Fast rows through the existing `codex` provider only, including names, descriptions, and input modalities; verify no second provider registration is introduced and standard catalog-shaped output contains Fast rows.
- [x] 3.2 Update `resolveModel()` to resolve synthetic IDs through inherited base metadata and safe defaults for unknown IDs, preserving context, reasoning, image, and tool behavior; verify ordinary/Fast resolved model parity.
- [x] 3.3 Ensure `prepareCall()`/`stream()` dispatch resolves one immutable target per request while preserving the existing endpoint, OAuth, proxy, SSE, tools, image, reasoning, retry, and signal paths; verify adapter integration tests use mocked transport only.
- [x] 3.4 Apply purpose policy so ordinary conversation honors Fast mapping while `purpose === "compaction"` and `purpose === "session-title"` use the base model without `service_tier`; verify purpose-specific request-body assertions and no new DSH config/header fields.

## 4. Responses serialization and retry behavior

- [x] 4.1 Integrate target projection after normal message/input/tool/reasoning serialization so ordinary bodies omit `service_tier`, Fast bodies send base `model` plus `service_tier: "priority"`, and no `-fast` picker ID reaches the wire; verify exact JSON body tests.
- [x] 4.2 Preserve target/body mapping across one 401 credential refresh retry, including ChatGPT subscription field stripping and the same endpoint/headers; verify first and retry captured bodies are identical with Fast mapping.
- [x] 4.3 Confirm unsupported service-tier HTTP errors retain current safe provider classification and do not silently retry as ordinary; verify existing error tests plus a service-tier rejection fixture.

## 5. Actual-tier diagnostics and SSE compatibility

- [x] 5.1 Extend `translate()` to read only `response.completed.response.service_tier`, classify requested/actual/status as fulfilled, downgraded, unknown, or not-requested, and attach only allowlisted data through existing `finish.replayState.response`; verify priority→priority, priority→default, missing/unknown, and ordinary cases.
- [x] 5.2 Keep standard StreamChunk shape and event order unchanged while adding private metadata; verify text, reasoning, tool-call, usage, finish, incomplete, failed, and natural-close fixtures still pass for ordinary and Fast rows.
- [x] 5.3 Verify degraded Fast completion does not fail or trigger retry and does not log sensitive content; verify mock SSE completes normally and diagnostics redaction assertions pass.
- [x] 5.4 Verify whether local DSH assembly preserves `finish.replayState.response` using a non-network replay fixture; if Web UI cannot reliably expose it, record the limitation and leave UI work for a follow-up change rather than adding a standard chunk field.

## 6. Documentation, compatibility, and release preparation

- [x] 6.1 Update `README.md` with ordinary/Fast picker examples, `service_tier: "priority"` semantics, capability detection rules, quota/premium/downgrade caveats, auxiliary-purpose policy, actual-tier diagnostics limitation, and rollback to base model; verify examples match implementation and do not claim guaranteed Fast usage.
- [x] 6.2 Add configuration/static catalog examples for optional service-tier metadata while keeping existing configs valid and leaving default `clientVersion: 0.144.1` unchanged; verify old configuration fixtures load without migration.
- [x] 6.3 Decide and record the compatible minor version bump in `package.json`/release notes only after tests pass; verify peer compatibility remains DSH `0.1.2-rc.1` and no new adapter dependency or provider route is added.

## 7. Verification and delivery gate

- [x] 7.1 Run the complete non-network test suite (`npm test`) and verify all pre-existing tests plus the full Fast matrix pass.
- [x] 7.2 Run targeted serialization/catalog/error tests independently and verify no test invokes `test/smoke.mjs` or sends a real Codex request.
- [x] 7.3 Run `openspec validate --change "add-codex-fast-synthetic-model" --strict` and review the final file-level diff to confirm only planning artifacts are delivered in this proposal phase; do not publish npm, alter production, restart 3080, or modify DSH core.

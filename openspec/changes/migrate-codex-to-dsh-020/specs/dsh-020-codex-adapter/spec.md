## Purpose

让 Codex 订阅模型作为一个符合 DSH `0.2.0-rc.2` 运行时契约的 LLM provider 安全、可配置且可验证地运行，同时保持现有模型发现、流式输出和凭证刷新能力。

## ADDED Requirements

### Requirement: DSH 0.2 compatibility declaration

The plugin package SHALL declare peer and development dependencies compatible with DSH `0.2.0-rc.2`, including the DSH LLM, Settings, and Timeout packages, and SHALL expose only package files that exist in the published archive.

#### Scenario: Desktop compatibility check accepts the package

- **WHEN** the plugin is installed into a profile whose host provides DSH `0.2.0-rc.2`
- **THEN** the plugin's declared peer ranges SHALL accept the host packages without an incompatibility warning caused by the version range

#### Scenario: Published archive contains declared runtime entry points

- **WHEN** the plugin is packed and installed from its archive
- **THEN** its bundle patch, module entry point, and all imported runtime dependencies SHALL resolve from the archive and installed dependency graph

### Requirement: DSH 0.2 provider registration

The plugin SHALL register exactly one Codex provider route and SHALL expose valid provider and model metadata accepted by the DSH 0.2 LLM runtime.

#### Scenario: Provider registration succeeds

- **WHEN** the plugin is activated with the DSH LLM service available
- **THEN** the provider route `codex` SHALL be registered once with a non-empty display name and SHALL be removable with the plugin lifecycle

#### Scenario: Model catalog metadata is accepted

- **WHEN** the runtime requests the Codex model catalog or resolves an exact model
- **THEN** every returned model SHALL preserve the requested provider and model identity, use a non-empty name, and expose only valid context, output-limit, modality, and reasoning metadata

### Requirement: DSH 0.2 configuration behavior

The plugin SHALL consume its declared configuration through the DSH 0.2 plugin configuration lifecycle and SHALL NOT depend on the removed DSH 0.1 `settings.installSection()` API.

#### Scenario: Configuration is available at activation

- **WHEN** the plugin is activated with default or profile-provided configuration
- **THEN** Codex requests SHALL use the resolved configuration, including client version, write-back policy, timeout, proxy, credential paths, and static model overrides

#### Scenario: Settings service is absent or replaced

- **WHEN** the optional Settings service is unavailable, appears later, or is replaced during host lifecycle changes
- **THEN** the provider SHALL remain operable from its plugin configuration and SHALL not call an unavailable `installSection()` method

#### Scenario: Runtime configuration changes take effect

- **WHEN** a supported volatile configuration field changes through the DSH 0.2 configuration mechanism
- **THEN** subsequent model discovery and requests SHALL use the new resolved configuration without requiring a restart, while an in-flight request SHALL retain a coherent configuration generation

### Requirement: Configuration-generation-bound model calls

The provider SHALL bind model resolution and the subsequent stream dispatch to one coherent configuration generation so that a configuration or HMR change cannot combine metadata from one generation with transport or credentials from another.

#### Scenario: Configuration remains stable during a prepared call

- **WHEN** the runtime prepares a Codex call and then dispatches it
- **THEN** the call SHALL use the model metadata and request transport options captured for the same generation

#### Scenario: Configuration changes before the next call

- **WHEN** Codex configuration changes after a call completes and before another call is prepared
- **THEN** the next call SHALL use the new configuration and SHALL not reuse the prior call's proxy, credentials, or endpoint facts

### Requirement: Existing Codex behavior remains intact

The provider SHALL preserve Codex subscription behavior already exposed by the plugin, including local credential loading and refresh, proxy-aware Responses requests, SSE translation, tool calls, supported image input, Fast synthetic model tier mapping, safe diagnostics, and DSH terminal stream ordering.

#### Scenario: Successful text stream

- **WHEN** the Codex Responses endpoint emits a valid text response with usage and a terminal completion event
- **THEN** the provider SHALL emit valid DSH chunks, emit usage before finish, and finish with a stop outcome containing any applicable replay metadata

#### Scenario: Successful tool call stream

- **WHEN** the endpoint emits a function-call item and argument deltas
- **THEN** the provider SHALL emit a valid tool-call block and finish with a tool-calls outcome while preserving raw JSON argument deltas

#### Scenario: Authentication refresh

- **WHEN** a ChatGPT subscription request receives one authentication failure
- **THEN** the provider SHALL refresh credentials once, retry the same logical request with the applicable tier and headers, and surface a classified authentication error if refresh fails

#### Scenario: Timeout or caller cancellation

- **WHEN** the caller aborts the request or the stream idle deadline expires
- **THEN** the provider SHALL stop/close the provider stream and expose an appropriate DSH aborted or timeout failure without leaking timers or iterators

#### Scenario: Provider or stream failure

- **WHEN** the provider returns an HTTP, SSE, malformed-response, incomplete, or premature-close failure
- **THEN** the provider SHALL return a bounded, secret-safe, machine-classifiable terminal failure and SHALL not expose request prompts, tool results, images, or credentials in diagnostics

### Requirement: Independent DSH 0.2 verification

The migration SHALL be verifiable in a new, separate DSH `0.2.0-rc.2` instance or profile without restarting or modifying the current session's `3080` instance.

#### Scenario: Isolated installation smoke test

- **WHEN** the packed or linked plugin is installed into the separate DSH 0.2 test environment
- **THEN** bundle composition, provider activation, model listing, settings/config loading, and a controlled stream smoke test SHALL complete without changing the current DSH instance

#### Scenario: Current instance is untouched

- **WHEN** migration tests are run
- **THEN** no test step SHALL restart, replace, or reconfigure the current session's `http://127.0.0.1:3080` service

/**
 * Codex picker-id and service-tier mapping.
 *
 * Picker ids are plugin-owned values. Only the resolved wire target is allowed
 * to reach the upstream Responses API.
 */

export const CODEX_FAST_SUFFIX = '-fast';
export const CODEX_FAST_SERVICE_TIER = 'priority';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Split one picker id without guessing from display names. */
export function parsePickerModelId(id) {
  const value = typeof id === 'string' ? id : String(id ?? '');
  if (value.endsWith(CODEX_FAST_SUFFIX) && value.length > CODEX_FAST_SUFFIX.length) {
    return {
      wireId: value.slice(0, -CODEX_FAST_SUFFIX.length),
      fast: true,
    };
  }
  return { wireId: value, fast: false };
}

/** Resolve a picker id to the model and optional service tier sent upstream. */
export function resolveWireModel(id) {
  const parsed = parsePickerModelId(id);
  return {
    wireId: parsed.wireId,
    ...(parsed.fast ? { serviceTier: CODEX_FAST_SERVICE_TIER } : {}),
  };
}

/** Auxiliary calls intentionally use the base model/default tier. */
export function effectiveWireTarget(id, purpose) {
  const target = resolveWireModel(id);
  return purpose === 'compaction' || purpose === 'session-title'
    ? { wireId: target.wireId }
    : target;
}

/** Project a Responses body without mutating it or leaking the picker id. */
export function applyWireTarget(body, target) {
  if (!isRecord(body)) return body;
  const { service_tier: _ignoredServiceTier, ...rest } = body;
  return {
    ...rest,
    model: target.wireId,
    ...(target.serviceTier === undefined ? {} : { service_tier: target.serviceTier }),
  };
}

function normalizedServiceTiers(entry) {
  if (!Array.isArray(entry?.serviceTiers) && !Array.isArray(entry?.service_tiers)) return [];
  const values = entry.serviceTiers ?? entry.service_tiers;
  return values
    .filter((tier) => isRecord(tier) && typeof tier.id === 'string' && tier.id.length > 0)
    .map((tier) => ({
      id: tier.id,
      ...(typeof tier.name === 'string' && tier.name.length > 0 ? { name: tier.name } : {}),
      ...(typeof tier.description === 'string' && tier.description.length > 0
        ? { description: tier.description }
        : {}),
    }));
}

/**
 * Detect explicit Fast capability. A priority service tier wins; the legacy
 * speed-tier array is only a compatibility fallback. Unknown tiers are never
 * treated as Fast.
 */
export function supportsFast(entry) {
  if (normalizedServiceTiers(entry).some((tier) => tier.id === CODEX_FAST_SERVICE_TIER)) return true;
  const legacy = entry?.additionalSpeedTiers ?? entry?.additional_speed_tiers;
  return Array.isArray(legacy) && legacy.some((tier) => tier === 'fast');
}

export function fastServiceTier(entry) {
  return normalizedServiceTiers(entry).find((tier) => tier.id === CODEX_FAST_SERVICE_TIER);
}

export function normalizeServiceTiers(entry) {
  return normalizedServiceTiers(entry);
}

export type PricingPolicy = Readonly<{
  version: string;
  model: string;
  currency: string;
  minorUnitDigits: number;
  unit: "provider_minute";
  rateMinorUnitsPerMinute: number;
  effectiveFrom: number;
  rounding: "half_up_minor_unit";
  evidence: Readonly<{ kind: "synthetic" } | { kind: "verified"; sourceUrl: string; checkedAt: number }>;
}>;

export type CostEstimate = Readonly<{
  status: "estimated";
  policyVersion: string;
  model: string;
  currency: string;
  unit: "provider_minute";
  amountMinorUnits: string;
  usageSeconds: number;
  rounding: "half_up_minor_unit";
}> | Readonly<{ status: "unavailable"; reason: "unknown_usage" | "missing_policy" }>;

// No verified per-second price policy is available for this product yet.
export const PRICING_POLICIES: readonly PricingPolicy[] = Object.freeze([]);

function validatePolicies(policies: readonly PricingPolicy[]): void {
  const seen = new Set<string>();
  for (const policy of policies) {
    if (!policy.version || !policy.model || !/^[A-Z]{3}$/.test(policy.currency) ||
        !Number.isSafeInteger(policy.minorUnitDigits) || policy.minorUnitDigits < 0 || policy.minorUnitDigits > 6 ||
        !Number.isSafeInteger(policy.rateMinorUnitsPerMinute) || policy.rateMinorUnitsPerMinute < 0 ||
        !Number.isSafeInteger(policy.effectiveFrom) || policy.effectiveFrom < 0 ||
        policy.unit !== "provider_minute" || policy.rounding !== "half_up_minor_unit") {
      throw new Error("invalid_pricing_policy");
    }
    if (policy.evidence.kind === "verified" && (!policy.evidence.sourceUrl || !Number.isSafeInteger(policy.evidence.checkedAt))) {
      throw new Error("invalid_pricing_policy_evidence");
    }
    const key = `${policy.model}\0${policy.version}`;
    if (seen.has(key)) throw new Error("duplicate_pricing_policy_version");
    seen.add(key);
  }
}

function historicalPolicy(model: string, at: number, savedVersion: string | null, policies: readonly PricingPolicy[]): PricingPolicy | null {
  validatePolicies(policies);
  const matches = policies.filter(policy => policy.model === model && policy.effectiveFrom <= at);
  if (savedVersion !== null) return matches.find(policy => policy.version === savedVersion) ?? null;
  return matches.sort((a, b) => b.effectiveFrom - a.effectiveFrom || b.version.localeCompare(a.version))[0] ?? null;
}

function currentPolicy(model: string, asOf: number, policies: readonly PricingPolicy[]): PricingPolicy | null {
  return historicalPolicy(model, asOf, null, policies);
}

function decimalFraction(value: number): { numerator: bigint; denominator: bigint } {
  const [mantissa, exponentText] = value.toString().toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  const [whole, fraction = ""] = mantissa!.split(".");
  const numeratorText = `${whole}${fraction}`.replace(/^\+/, "");
  const power = fraction.length - exponent;
  return power >= 0
    ? { numerator: BigInt(numeratorText), denominator: 10n ** BigInt(power) }
    : { numerator: BigInt(numeratorText) * 10n ** BigInt(-power), denominator: 1n };
}

function cost(seconds: number | null, policy: PricingPolicy | null): CostEstimate {
  if (seconds === null) return { status: "unavailable", reason: "unknown_usage" };
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("invalid_provider_seconds");
  if (!policy) return { status: "unavailable", reason: "missing_policy" };
  const { numerator, denominator } = decimalFraction(seconds);
  const divisor = denominator * 60n;
  const amountMinorUnits = (numerator * BigInt(policy.rateMinorUnitsPerMinute) + divisor / 2n) / divisor;
  return { status: "estimated", policyVersion: policy.version, model: policy.model, currency: policy.currency, unit: policy.unit,
    amountMinorUnits: amountMinorUnits.toString(), usageSeconds: seconds, rounding: policy.rounding };
}

export function assignPricingPolicyVersion(model: string, dispatchedAt: number, policies: readonly PricingPolicy[] = PRICING_POLICIES): string | null {
  return historicalPolicy(model, dispatchedAt, null, policies)?.version ?? null;
}

export function estimateHistoricalCost(seconds: number | null, model: string, dispatchedAt: number,
  savedPolicyVersion: string | null, policies: readonly PricingPolicy[] = PRICING_POLICIES): CostEstimate {
  return cost(seconds, historicalPolicy(model, dispatchedAt, savedPolicyVersion, policies));
}

export function estimateCurrentPriceScenario(seconds: number | null, model: string, asOf: number,
  policies: readonly PricingPolicy[] = PRICING_POLICIES): CostEstimate {
  return cost(seconds, currentPolicy(model, asOf, policies));
}

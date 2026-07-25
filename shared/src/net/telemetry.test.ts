import { describe, expect, it } from "vitest";
import { bucketFps, clientMetricBodySchema, deviceClassOf, FPS_BUCKETS } from "./telemetry.js";

describe("bucketFps", () => {
  it("bands each range at its half-open boundaries", () => {
    // Lower edge is inclusive, upper edge belongs to the next band.
    expect(bucketFps(0)).toBe("<20");
    expect(bucketFps(19.99)).toBe("<20");
    expect(bucketFps(20)).toBe("20-30");
    expect(bucketFps(29.99)).toBe("20-30");
    expect(bucketFps(30)).toBe("30-45");
    expect(bucketFps(44.99)).toBe("30-45");
    expect(bucketFps(45)).toBe("45-60");
    expect(bucketFps(59.99)).toBe("45-60");
    expect(bucketFps(60)).toBe("60+");
    expect(bucketFps(144)).toBe("60+");
  });

  it("is total: garbage readings land in the pessimistic band, never throw", () => {
    expect(bucketFps(Number.NaN)).toBe("<20");
    expect(bucketFps(Number.POSITIVE_INFINITY)).toBe("<20");
    expect(bucketFps(Number.NEGATIVE_INFINITY)).toBe("<20");
    expect(bucketFps(-5)).toBe("<20");
  });

  it("only ever returns a declared bucket", () => {
    for (const fps of [0, 1, 19, 20, 25, 30, 37, 45, 50, 60, 61, 1000]) {
      expect(FPS_BUCKETS).toContain(bucketFps(fps));
    }
  });
});

describe("deviceClassOf", () => {
  it("maps the quality device probe to the two classes", () => {
    expect(deviceClassOf({ mobile: true })).toBe("mobile");
    expect(deviceClassOf({ mobile: false })).toBe("desktop");
  });
});

describe("clientMetricBodySchema", () => {
  const valid = {
    sessionHash: "0123456789abcdef0123456789abcdef",
    fpsBucket: "30-45",
    deviceClass: "mobile",
    qualityTier: "med",
  };

  it("accepts a well-formed report", () => {
    expect(clientMetricBodySchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a session hash that is not 32-64 lowercase hex", () => {
    for (const sessionHash of [
      "short",
      "0123456789ABCDEF0123456789ABCDEF", // uppercase
      "0123456789abcdef0123456789abcde", // 31 chars
      "g123456789abcdef0123456789abcdef", // non-hex
      "0123456789abcdef".repeat(5), // 80 chars
      "550e8400-e29b-41d4-a716-446655440000", // uuid shape
    ]) {
      expect(clientMetricBodySchema.safeParse({ ...valid, sessionHash }).success).toBe(false);
    }
  });

  it("rejects unknown enum values", () => {
    expect(clientMetricBodySchema.safeParse({ ...valid, fpsBucket: "90+" }).success).toBe(false);
    expect(clientMetricBodySchema.safeParse({ ...valid, deviceClass: "tablet" }).success).toBe(false);
    expect(clientMetricBodySchema.safeParse({ ...valid, qualityTier: "ultra" }).success).toBe(false);
  });

  it("rejects missing fields", () => {
    for (const key of Object.keys(valid)) {
      const body: Record<string, unknown> = { ...valid };
      delete body[key];
      expect(clientMetricBodySchema.safeParse(body).success).toBe(false);
    }
  });

  it("rejects extra keys — a client must not be able to smuggle in an identifier", () => {
    expect(clientMetricBodySchema.safeParse({ ...valid, userId: "u-1" }).success).toBe(false);
    expect(clientMetricBodySchema.safeParse({ ...valid, email: "a@b.c" }).success).toBe(false);
  });
});

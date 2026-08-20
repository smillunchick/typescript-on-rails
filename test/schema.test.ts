import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as publicApi from "../src/index.js";
import {
  CANONICAL_SCHEMA_VERSION,
  InvalidInput,
  SCHEMA_PROTOCOL_MARKER,
  SCHEMA_PROTOCOL_VERSION,
  Unexpected,
  adaptSchema,
  array,
  boolean,
  date,
  enumOf,
  id,
  literal,
  money,
  number,
  object,
  optional,
  string,
  type Infer,
  type SchemaMetadata,
} from "../src/index.js";
import { normalizeSchema } from "../src/features/runtime/schema-protocol.js";

describe("schemas", () => {
  it("validates and types a nested object", () => {
    const Person = object({
      id: id("Person"),
      name: string(),
      age: number(),
      active: boolean(),
      birthday: date(),
      balance: money(),
      role: enumOf("admin", "member"),
      label: literal("person"),
      nickname: optional(string()),
      tags: array(string()),
    });

    type Person = Infer<typeof Person>;
    const person: Person = Person.parse({
      id: "person_1",
      name: "Ada",
      age: 36,
      active: true,
      birthday: new Date("1990-01-01T00:00:00.000Z"),
      balance: 1250,
      role: "admin",
      label: "person",
      tags: ["founder"],
      ignored: "not returned",
    });

    assert.equal(person.name, "Ada");
    assert.equal(person.nickname, undefined);
    assert.deepEqual(Object.keys(person).sort(), [
      "active",
      "age",
      "balance",
      "birthday",
      "id",
      "label",
      "name",
      "nickname",
      "role",
      "tags",
    ]);
  });

  it("returns path-aware issues for all invalid nested fields", () => {
    const Input = object({
      customer: object({ name: string() }),
      totals: array(money()),
    });

    assert.throws(
      () => Input.parse({ customer: { name: 42 }, totals: [10, -1, "bad"] }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInput);
        assert.deepEqual(
          error.issues.map((issue) => issue.path),
          [["customer", "name"], ["totals", 1], ["totals", 2]],
        );
        return true;
      },
    );
  });

  it("retains JSON-serializable metadata", () => {
    const schema = object({ status: enumOf("open", "closed"), ownerId: id("User") });
    assert.doesNotThrow(() => JSON.stringify(schema.metadata));
    assert.deepEqual(schema.metadata, {
      kind: "object",
      fields: {
        status: { kind: "enum", values: ["open", "closed"] },
        ownerId: { kind: "id", entity: "User" },
      },
    });
  });

  it("rejects invalid primitive, collection, and money values", () => {
    const invalidValues: ReadonlyArray<readonly [string, () => unknown]> = [
      ["string", () => string().parse(12)],
      ["finite number", () => number().parse(Number.POSITIVE_INFINITY)],
      ["boolean", () => boolean().parse("true")],
      ["date", () => date().parse(new Date("invalid"))],
      ["blank id", () => id().parse(" \t ")],
      ["negative money", () => money().parse(-1)],
      ["fractional money", () => money().parse(1.5)],
      ["unsafe money", () => money().parse(Number.MAX_SAFE_INTEGER + 1)],
      ["enum", () => enumOf("open", "closed").parse("missing")],
      ["literal", () => literal(false).parse(0)],
      ["array", () => array(string()).parse({})],
      ["object array", () => object({}).parse([])],
      ["object null", () => object({}).parse(null)],
    ];

    for (const [name, parse] of invalidValues) {
      assert.throws(parse, InvalidInput, name);
    }
  });

  it("exposes only the safe public schema construction path", () => {
    assert.equal(typeof publicApi.adaptSchema, "function");
    assert.equal("createSchema" in publicApi, false);
    assert.equal("normalizeSchema" in publicApi, false);
    assert.equal("isSchema" in publicApi, false);
  });

  it("adapts a synchronous parser and retains canonical nested extension metadata", () => {
    const metadata = {
      kind: "object",
      fields: {
        ownerId: { kind: "id", entity: "User" },
        amount: { kind: "money", currency: "minor-unit" },
        reference: {
          kind: "extension",
          namespace: "example.test",
          name: "reference",
          version: "1",
          payload: { z: [true, null], a: { label: "reference" } },
          underlying: { kind: "string" },
        },
      },
    } as const satisfies SchemaMetadata;
    const adapted = adaptSchema({
      metadata,
      parse: (value: unknown) => typeof value === "object" && value !== null
        ? { success: true as const, value: value as { ownerId: string; amount: number; reference: string } }
        : { success: false as const, error: { field: "root" } },
      mapError: () => [{ code: "invalid_type", expected: "object", received: "string" }],
    });

    assert.deepEqual(adapted.parse({ ownerId: "u1", amount: 100, reference: "ref" }), {
      ownerId: "u1",
      amount: 100,
      reference: "ref",
    });
    assert.deepEqual(adapted.metadata, {
      ...metadata,
      fields: {
        amount: metadata.fields.amount,
        ownerId: metadata.fields.ownerId,
        reference: {
          ...metadata.fields.reference,
          payload: { a: { label: "reference" }, z: [true, null] },
        },
      },
    });
    assert.equal(adapted[SCHEMA_PROTOCOL_MARKER].protocolVersion, SCHEMA_PROTOCOL_VERSION);
    assert.equal(adapted[SCHEMA_PROTOCOL_MARKER].canonicalVersion, CANONICAL_SCHEMA_VERSION);
  });

  it("sanitizes adapted failures and keeps raw parser throws internal", () => {
    const vendorFailure = {
      message: "secret-token vendor message",
      raw: { password: "secret-password" },
      stack: "secret-stack",
      error: new Error("secret-error"),
    };
    const rejected = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: () => ({ success: false as const, error: vendorFailure }),
      mapError: () => [{
        path: ["profile", "name"],
        code: "invalid_type",
        expected: "string",
        received: "number",
      }],
    });

    assert.throws(() => rejected.parse(42), (error: unknown) => {
      assert.ok(error instanceof InvalidInput);
      assert.deepEqual(error.issues, [{
        path: ["profile", "name"],
        code: "invalid_type",
        message: "Invalid type",
        expected: "string",
        received: "number",
      }]);
      const publicError = JSON.stringify({ message: error.message, details: error.details });
      assert.doesNotMatch(publicError, /secret-token|secret-password|secret-stack|secret-error|vendor/);
      return true;
    });

    const thrown = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: () => {
        throw vendorFailure;
      },
      mapError: () => [{ code: "invalid_value" }],
    });
    assert.throws(() => thrown.parse("value"), (error: unknown) => {
      assert.ok(error instanceof Unexpected);
      assert.equal(error.message, "Unexpected framework error");
      assert.equal(error.details, undefined);
      assert.equal(error.cause, vendorFailure);
      return true;
    });
  });

  it("wraps secret-bearing framework errors thrown by vendor callbacks", () => {
    const parserError = new InvalidInput(
      "secret parser message",
      [{ path: [], message: "secret parser issue" }],
      { details: { token: "secret-parser-token" } },
    );
    const mapperError = new InvalidInput(
      "secret mapper message",
      [{ path: [], message: "secret mapper issue" }],
      { details: { token: "secret-mapper-token" } },
    );
    const parserThrows = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: () => {
        throw parserError;
      },
      mapError: () => [{ code: "invalid_value" }],
    });
    const mapperThrows = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: () => ({ success: false as const, error: "vendor failure" }),
      mapError: () => {
        throw mapperError;
      },
    });

    for (const [parse, cause] of [
      [() => parserThrows.parse("value"), parserError],
      [() => mapperThrows.parse("value"), mapperError],
    ] as const) {
      assert.throws(parse, (error: unknown) => {
        assert.ok(error instanceof Unexpected);
        assert.equal(error.message, "Unexpected framework error");
        assert.equal(error.details, undefined);
        assert.equal(error.cause, cause);
        assert.doesNotMatch(
          JSON.stringify({ message: error.message, details: error.details }),
          /secret|vendor/,
        );
        return true;
      });
    }
  });

  it("fails safely for invalid parser results and mapper outputs", () => {
    const invalidResult = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: (() => ({ value: "missing discriminator" })) as never,
      mapError: () => [{ code: "invalid_value" }],
    });
    const mapperThenable = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: () => ({ success: false as const, error: "secret vendor failure" }),
      mapError: (() => Promise.resolve([{ code: "invalid_value" }])) as never,
    });
    const malformedIssue = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: () => ({ success: false as const, error: "secret vendor failure" }),
      mapError: (() => [{ code: "secret-vendor-code", message: "secret vendor message" }]) as never,
    });

    for (const parse of [
      () => invalidResult.parse("value"),
      () => mapperThenable.parse("value"),
      () => malformedIssue.parse("value"),
    ]) {
      assert.throws(parse, (error: unknown) => {
        assert.ok(error instanceof Unexpected);
        assert.equal(error.message, "Unexpected framework error");
        assert.equal(error.details, undefined);
        assert.doesNotMatch(
          JSON.stringify({ message: error.message, details: error.details }),
          /secret|vendor/,
        );
        return true;
      });
    }
  });

  it("retains own __proto__ keys without changing accumulator prototypes", () => {
    const payload: Record<string, unknown> = {};
    Object.defineProperty(payload, "__proto__", {
      value: { label: "safe" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const fields: Record<string, SchemaMetadata> = {};
    Object.defineProperty(fields, "__proto__", {
      value: { kind: "string" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    const extension = adaptSchema({
      metadata: {
        kind: "extension",
        namespace: "example.test",
        name: "prototype-key",
        version: "1",
        payload,
        underlying: { kind: "string" },
      } as SchemaMetadata,
      parse: (value: unknown) => ({ success: true as const, value: String(value) }),
      mapError: () => [{ code: "invalid_value" }],
    });
    const objectSchema = adaptSchema({
      metadata: { kind: "object", fields } as SchemaMetadata,
      parse: (value: unknown) => ({ success: true as const, value }),
      mapError: () => [{ code: "invalid_value" }],
    });

    assert.equal(extension.metadata.kind, "extension");
    if (extension.metadata.kind === "extension") {
      const normalizedPayload = extension.metadata.payload;
      if (typeof normalizedPayload !== "object" || normalizedPayload === null || Array.isArray(normalizedPayload)) {
        throw new Error("Expected an object extension payload");
      }
      const normalizedObject = normalizedPayload as Readonly<Record<string, unknown>>;
      assert.equal(Object.hasOwn(normalizedObject, "__proto__"), true);
      assert.equal(Object.getPrototypeOf(normalizedObject), Object.prototype);
      assert.deepEqual(normalizedObject["__proto__"], { label: "safe" });
    }
    assert.equal(objectSchema.metadata.kind, "object");
    if (objectSchema.metadata.kind === "object") {
      assert.equal(Object.hasOwn(objectSchema.metadata.fields, "__proto__"), true);
      assert.equal(Object.getPrototypeOf(objectSchema.metadata.fields), Object.prototype);
      assert.deepEqual(objectSchema.metadata.fields["__proto__"], { kind: "string" });
    }
  });

  it("normalizes the exact legacy shape without invoking its parser", () => {
    let calls = 0;
    const legacy = {
      metadata: { kind: "string" } as const,
      parse(value: unknown) {
        calls += 1;
        return String(value);
      },
    };
    const normalized = normalizeSchema(legacy);

    assert.equal(calls, 0);
    assert.equal(normalized.provenance, "legacy");
    assert.equal(normalized.parse("value"), "value");
    assert.equal(calls, 1);
    assert.throws(
      () => normalizeSchema({ ...legacy, extra: true } as never),
      (error: unknown) => error instanceof InvalidInput && error.issues[0]?.path[0] === SCHEMA_PROTOCOL_MARKER,
    );

    const symbolExtra = { ...legacy, [Symbol("extra")]: true };
    const nonEnumerableExtra = { ...legacy };
    Object.defineProperty(nonEnumerableExtra, "extra", { value: true });
    for (const candidate of [symbolExtra, nonEnumerableExtra]) {
      assert.throws(
        () => normalizeSchema(candidate as never),
        (error: unknown) => error instanceof InvalidInput && error.issues[0]?.path[0] === SCHEMA_PROTOCOL_MARKER,
      );
    }
  });

  it("rejects malformed protocols and canonical metadata with declaration paths", () => {
    const parser = () => ({ success: true as const, value: "ok" });
    const protocol = (metadata: unknown, overrides: Record<string, unknown> = {}) => ({
      metadata,
      parse: () => "outer parse must not run",
      [SCHEMA_PROTOCOL_MARKER]: {
        protocolVersion: SCHEMA_PROTOCOL_VERSION,
        canonicalVersion: CANONICAL_SCHEMA_VERSION,
        metadata,
        parse: parser,
        ...overrides,
      },
    });
    const cyclic: { kind: string; inner?: unknown } = { kind: "optional" };
    cyclic.inner = cyclic;
    const malformed: readonly [string, unknown, readonly (string | number)[]][] = [
      ["version", protocol({ kind: "string" }, { protocolVersion: "2" }), [SCHEMA_PROTOCOL_MARKER, "protocolVersion"]],
      ["parser", protocol({ kind: "string" }, { parse: 1 }), [SCHEMA_PROTOCOL_MARKER, "parse"]],
      ["unknown kind", protocol({ kind: "unknown" }), [SCHEMA_PROTOCOL_MARKER, "metadata", "kind"]],
      ["cyclic", protocol(cyclic), [SCHEMA_PROTOCOL_MARKER, "metadata", "inner"]],
      ["invalid JSON", protocol({ kind: "extension", namespace: "x", name: "y", version: "1", payload: { value: undefined }, underlying: { kind: "string" } }), [SCHEMA_PROTOCOL_MARKER, "metadata", "payload", "value"]],
      ["incomplete extension", protocol({ kind: "extension", namespace: "", name: "y", version: "1", payload: null, underlying: { kind: "string" } }), [SCHEMA_PROTOCOL_MARKER, "metadata", "namespace"]],
    ];

    for (const [name, candidate, path] of malformed) {
      assert.throws(
        () => normalizeSchema(candidate as never),
        (error: unknown) => error instanceof InvalidInput && assert.deepEqual(error.issues[0]?.path, path) === undefined,
        name,
      );
    }

    assert.throws(
      () => adaptSchema({ metadata: { kind: "string" }, parse: 1, mapError: () => [] } as never),
      (error: unknown) => error instanceof InvalidInput && assert.deepEqual(error.issues[0]?.path, ["parse"]) === undefined,
    );
    assert.throws(
      () => adaptSchema({ metadata: { kind: "string" }, parse: parser, mapError: 1 } as never),
      (error: unknown) => error instanceof InvalidInput && assert.deepEqual(error.issues[0]?.path, ["mapError"]) === undefined,
    );
  });

  it("rejects parser thenables synchronously", () => {
    const adapted = adaptSchema({
      metadata: { kind: "string" } as const,
      parse: (() => Promise.resolve({ success: true as const, value: "late" })) as unknown as () => { readonly success: true; readonly value: string },
      mapError: () => [{ code: "invalid_value" }],
    });

    assert.throws(() => adapted.parse("value"), Unexpected);
  });
});

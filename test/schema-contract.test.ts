import assert from "node:assert/strict";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import ts from "typescript";

import {
  extractAdapterOperationsFacet,
  extractRuntimeSchemaFacet,
  extractSchemaFieldsFacet,
} from "../src/infra/typescript/index.js";
import { createAppFixture, type AppFixture } from "./helpers/app-fixture.js";

const fixtures: AppFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

interface CheckedFixture {
  readonly checker: ts.TypeChecker;
  expression(name: string, relativeFile?: string): ts.Expression;
}

async function checkedFixture(files: Readonly<Record<string, string>>): Promise<CheckedFixture> {
  const fixture = await createAppFixture(files);
  fixtures.push(fixture);
  const configPath = path.join(fixture.root, "tsconfig.json");
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fixture.root, undefined, configPath);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();

  return {
    checker,
    expression(name, relativeFile = "src/features/contracts/index.ts") {
      const sourceFile = program.getSourceFile(path.join(fixture.root, relativeFile));
      assert.ok(sourceFile, `missing source file ${relativeFile}`);
      for (const statement of sourceFile.statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer !== undefined) {
            return declaration.initializer;
          }
        }
      }
      throw new Error(`missing initialized variable ${name}`);
    },
  };
}

function metadataOf(facet: ReturnType<typeof extractRuntimeSchemaFacet>) {
  assert.equal(facet.status, "resolved", facet.status === "unresolved" ? `${facet.diagnostic.code}: ${facet.diagnostic.path}: ${facet.diagnostic.detail ?? ""}` : undefined);
  if (facet.status !== "resolved") throw new Error("schema facet did not resolve");
  assert.equal(facet.provenance, "declared-schema");
  assert.equal(facet.validator, "declared");
  return facet.metadata;
}

describe("checker-only runtime schema contracts", () => {
  it("lowers every built-in metadata node and sorts nested object fields", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
import { array, boolean, date, enumOf, id, literal, money, number, object, optional, string } from "typescript-on-rails";
export const schema = object({
  zeta: string(),
  alpha: object({ z: array(optional(number())), a: boolean() }),
  date: date(),
  id: id(),
  entityId: id("Invoice"),
  money: money(),
  enum: enumOf("open", 2, true, null),
  literal: literal("fixed"),
});
`,
    });

    const metadata = metadataOf(extractRuntimeSchemaFacet(fixture.checker, fixture.expression("schema"), "schema"));
    assert.deepEqual(metadata, {
      kind: "object",
      fields: {
        alpha: {
          kind: "object",
          fields: {
            a: { kind: "boolean" },
            z: { kind: "array", items: { kind: "optional", inner: { kind: "number" } } },
          },
        },
        date: { kind: "date" },
        entityId: { kind: "id", entity: "Invoice" },
        enum: { kind: "enum", values: ["open", 2, true, null] },
        id: { kind: "id" },
        literal: { kind: "literal", value: "fixed" },
        money: { kind: "money", currency: "minor-unit" },
        zeta: { kind: "string" },
      },
    });
    assert.deepEqual(Object.keys(metadata.kind === "object" ? metadata.fields : {}), [
      "alpha", "date", "entityId", "enum", "id", "literal", "money", "zeta",
    ]);
  });

  it("treats local constants and imported aliases as the same checked schema", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/shared.ts": `
import { object, string } from "typescript-on-rails";
export const sharedSchema = object({ value: string() });
`,
      "src/features/contracts/index.ts": `
import { object, string } from "typescript-on-rails";
import { sharedSchema as importedAlias } from "./shared.js";
const localSchema = object({ value: string() });
export const local = localSchema;
export const imported = importedAlias;
`,
    });

    const local = metadataOf(extractRuntimeSchemaFacet(fixture.checker, fixture.expression("local"), "local"));
    const imported = metadataOf(extractRuntimeSchemaFacet(fixture.checker, fixture.expression("imported"), "imported"));
    assert.deepEqual(imported, local);
  });

  it("lowers adapted extension metadata and canonical JSON without invoking its parser", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
import { adaptSchema } from "typescript-on-rails";
throw new Error("application source must never execute during schema analysis");
export const adapted = adaptSchema({
  metadata: {
    kind: "extension",
    namespace: "vendor.example",
    name: "sku",
    version: "1",
    payload: { z: [true, null, -0], a: { label: "SKU", count: 2 } },
    underlying: { kind: "string" },
  },
  parse: (value: unknown) => ({ success: true as const, value }),
  mapError: () => [],
});
`,
    });

    assert.deepEqual(
      metadataOf(extractRuntimeSchemaFacet(fixture.checker, fixture.expression("adapted"), "adapted")),
      {
        kind: "extension",
        namespace: "vendor.example",
        name: "sku",
        version: "1",
        payload: { a: { count: 2, label: "SKU" }, z: [true, null, 0] },
        underlying: { kind: "string" },
      },
    );
  });

  it("rejects class-backed metadata supplied through adaptSchema", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
import { adaptSchema } from "typescript-on-rails";
class MetadataClass { kind = "string" as const; }
export const adapted = adaptSchema({
  metadata: new MetadataClass(),
  parse: (value: unknown) => ({ success: true as const, value }),
  mapError: () => [],
});
export const nested = adaptSchema({
  metadata: { kind: "optional", inner: new MetadataClass() },
  parse: (value: unknown) => ({ success: true as const, value }),
  mapError: () => [],
});
`,
    });

    const expected = new Map([
      ["adapted", 'adapted."typescript-on-rails.schema"."metadata"'],
      ["nested", 'nested."typescript-on-rails.schema"."metadata"."inner"'],
    ]);
    for (const [name, expectedPath] of expected) {
      const facet = extractRuntimeSchemaFacet(fixture.checker, fixture.expression(name), name);
      assert.equal(facet.status, "unresolved");
      if (facet.status === "unresolved") {
        assert.equal(facet.diagnostic.code, "SC002");
        assert.equal(facet.diagnostic.path, expectedPath);
      }
    }
  });

  it("turns model fields into one object facet and preserves sorted adapter schemas", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
import { boolean, number, object, string, type Schema } from "typescript-on-rails";
declare const opaqueSchema: Schema<unknown>;
export const fields = { z: number(), a: string() };
export const operations = {
  zeta: { input: object({ value: string() }), output: boolean() },
  alpha: { input: string(), output: number() },
};
export const partlyOpaqueOperations = {
  valid: { input: string(), output: boolean() },
  broken: { input: opaqueSchema, output: number() },
};
`,
    });

    assert.deepEqual(metadataOf(extractSchemaFieldsFacet(fixture.checker, fixture.expression("fields"), "fields")), {
      kind: "object",
      fields: { a: { kind: "string" }, z: { kind: "number" } },
    });

    const operations = extractAdapterOperationsFacet(fixture.checker, fixture.expression("operations"), "operations");
    assert.equal(operations.status, "resolved");
    if (operations.status !== "resolved") return;
    assert.deepEqual(Object.keys(operations.operations), ["alpha", "zeta"]);
    assert.deepEqual(metadataOf(operations.operations.alpha!.input), { kind: "string" });
    assert.deepEqual(metadataOf(operations.operations.alpha!.output), { kind: "number" });
    assert.deepEqual(metadataOf(operations.operations.zeta!.input), {
      kind: "object",
      fields: { value: { kind: "string" } },
    });
    assert.deepEqual(metadataOf(operations.operations.zeta!.output), { kind: "boolean" });
    assert.equal("staticType" in operations.operations.alpha!.input, false);

    const partlyOpaque = extractAdapterOperationsFacet(
      fixture.checker,
      fixture.expression("partlyOpaqueOperations"),
      "partlyOpaqueOperations",
    );
    assert.equal(partlyOpaque.status, "resolved");
    if (partlyOpaque.status !== "resolved") return;
    assert.deepEqual(Object.keys(partlyOpaque.operations), ["broken", "valid"]);
    assert.equal(partlyOpaque.operations.broken!.input.status, "unresolved");
    if (partlyOpaque.operations.broken!.input.status === "unresolved") {
      assert.equal(partlyOpaque.operations.broken!.input.diagnostic.code, "SC004");
    }
    assert.deepEqual(metadataOf(partlyOpaque.operations.broken!.output), { kind: "number" });
    assert.deepEqual(metadataOf(partlyOpaque.operations.valid!.input), { kind: "string" });
  });

  it("mirrors Object.entries for class-backed model fields and adapter operations", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
import { number, string } from "typescript-on-rails";
class BaseFields { inherited = number(); }
class ModelFields extends BaseFields {
  own = string();
  get prototypeGetter() { return number(); }
  prototypeMethod() { return number(); }
}
class BaseOperations { inherited = { input: number(), output: number() }; }
class Operations extends BaseOperations {
  own = { input: string(), output: number() };
  get prototypeGetter() { return { input: number(), output: number() }; }
}
export const classFields = new ModelFields();
export const classOperations = new Operations();
`,
    });

    assert.deepEqual(metadataOf(extractSchemaFieldsFacet(
      fixture.checker,
      fixture.expression("classFields"),
      "classFields",
    )), {
      kind: "object",
      fields: {
        inherited: { kind: "number" },
        own: { kind: "string" },
      },
    });
    const operations = extractAdapterOperationsFacet(
      fixture.checker,
      fixture.expression("classOperations"),
      "classOperations",
    );
    assert.equal(operations.status, "resolved");
    if (operations.status === "resolved") {
      assert.deepEqual(Object.keys(operations.operations), ["inherited", "own"]);
      assert.deepEqual(metadataOf(operations.operations.inherited!.input), { kind: "number" });
      assert.deepEqual(metadataOf(operations.operations.own!.input), { kind: "string" });
    }
  });

  it("fails closed for absent, widened, optional, indexed, union, recursive, and widened operation forms", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
import { string, type AdapterOperations, type Schema } from "typescript-on-rails";
throw new Error("opaque schema fixture must never execute during analysis");
declare const widened: Schema<string>;
declare const anyMetadata: { metadata: any; parse(value: unknown): unknown };
declare const notSchema: { metadata: { kind: "string" } };
declare const optionalMetadata: { metadata: { kind: "literal"; value?: "x" }; parse(value: unknown): string };
declare const indexedMetadata: { metadata: { kind: "object"; fields: { [key: string]: { kind: "string" } } }; parse(value: unknown): object };
interface RecursiveMetadata { readonly kind: "optional"; readonly inner: RecursiveMetadata }
declare const recursiveMetadata: { metadata: RecursiveMetadata; parse(value: unknown): unknown };
declare const unionSchema: typeof widened | ReturnType<typeof string>;
declare const indexedFields: Readonly<Record<string, ReturnType<typeof string>>>;
declare const widenedOperations: AdapterOperations;
export const widenedValue = widened;
export const anyValue = anyMetadata;
export const notSchemaValue = notSchema;
export const optionalValue = optionalMetadata;
export const indexedValue = indexedMetadata;
export const recursiveValue = recursiveMetadata;
export const unionValue = unionSchema;
export const fieldsValue = indexedFields;
export const operationsValue = widenedOperations;
`,
    });

    assert.deepEqual(extractRuntimeSchemaFacet(fixture.checker, undefined, "missing"), {
      status: "not-declared",
      validator: "not-declared",
    });
    const expected = new Map([
      ["widenedValue", "SC004"],
      ["anyValue", "SC004"],
      ["notSchemaValue", "SC004"],
      ["optionalValue", "SC004"],
      ["indexedValue", "SC004"],
      ["recursiveValue", "SC004"],
      ["unionValue", "SC001"],
    ]);
    for (const [name, code] of expected) {
      const facet = extractRuntimeSchemaFacet(fixture.checker, fixture.expression(name), name);
      assert.equal(facet.status, "unresolved", name);
      if (facet.status !== "unresolved") continue;
      assert.equal(facet.validator, "declared", name);
      assert.equal(facet.provenance, "declared-schema", name);
      assert.equal(facet.diagnostic.code, code, name);
      assert.equal(facet.diagnostic.path.startsWith(name), true, name);
      assert.equal("metadata" in facet, false, name);
    }
    const fields = extractSchemaFieldsFacet(fixture.checker, fixture.expression("fieldsValue"), "fieldsValue");
    assert.equal(fields.status, "unresolved");
    if (fields.status === "unresolved") assert.equal(fields.diagnostic.code, "SC002");
    const operations = extractAdapterOperationsFacet(fixture.checker, fixture.expression("operationsValue"), "operationsValue");
    assert.equal(operations.status, "unresolved");
    if (operations.status === "unresolved") assert.equal(operations.diagnostic.code, "SC002");
  });

  it("rejects noncanonical extension payloads and keeps __proto__ as own data", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
import { adaptSchema, string } from "typescript-on-rails";
declare const widenedString: string;
export const invalidJson = {
  metadata: {
    kind: "extension" as const,
    namespace: "test" as const,
    name: "invalid" as const,
    version: "1" as const,
    payload: { value: widenedString },
    underlying: { kind: "string" as const },
  },
  parse(value: unknown) { return value; },
};
export const protoFields = { ["__proto__"]: string(), safe: string() };
export const protoExtension = adaptSchema({
  metadata: {
    kind: "extension",
    namespace: "test",
    name: "proto",
    version: "1",
    payload: { ["__proto__"]: { polluted: true }, safe: "yes" },
    underlying: { kind: "string" },
  },
  parse: (value: unknown) => ({ success: true as const, value }),
  mapError: () => [],
});
`,
    });

    const invalid = extractRuntimeSchemaFacet(fixture.checker, fixture.expression("invalidJson"), "invalidJson");
    assert.equal(invalid.status, "unresolved");
    if (invalid.status === "unresolved") assert.equal(invalid.diagnostic.code, "SC003");

    const fields = metadataOf(extractSchemaFieldsFacet(fixture.checker, fixture.expression("protoFields"), "protoFields"));
    assert.equal(fields.kind, "object");
    if (fields.kind !== "object") return;
    assert.equal(Object.hasOwn(fields.fields, "__proto__"), true);
    assert.deepEqual(fields.fields["__proto__"], { kind: "string" });
    assert.equal(Object.getPrototypeOf(fields.fields), Object.prototype);

    const extension = metadataOf(extractRuntimeSchemaFacet(
      fixture.checker,
      fixture.expression("protoExtension"),
      "protoExtension",
    ));
    assert.equal(extension.kind, "extension");
    if (extension.kind !== "extension" || extension.payload === null || Array.isArray(extension.payload) || typeof extension.payload !== "object") return;
    assert.equal(Object.hasOwn(extension.payload, "__proto__"), true);
    assert.equal(Object.getPrototypeOf(extension.payload), Object.prototype);
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });

  it("distinguishes protocol and exact legacy wrappers without invoking parser code", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
import { SCHEMA_PROTOCOL_MARKER, type SchemaProtocolDescriptor } from "typescript-on-rails";
const parser = () => { throw new Error("schema parser must never run during analysis"); };
export const protocol = {
  metadata: { kind: "number" as const },
  parse: parser,
  extraTopLevel: true,
  [SCHEMA_PROTOCOL_MARKER]: {
    protocolVersion: "1" as const,
    canonicalVersion: "1" as const,
    metadata: { kind: "string" as const },
    parse: parser,
    permittedDescriptorExtra: true,
  },
};
const typedPublicDescriptor: SchemaProtocolDescriptor<string, { readonly kind: "string" }> = {
  protocolVersion: "1",
  canonicalVersion: "1",
  metadata: { kind: "string" },
  parse: () => ({ success: true, value: "ok" }),
};
export const publicDescriptorOnly = { [SCHEMA_PROTOCOL_MARKER]: typedPublicDescriptor };
export const legacy = { metadata: { kind: "boolean" as const }, parse: parser };
export const extraLegacy = { metadata: { kind: "string" as const }, parse: parser, extra: true };
declare const optionalMarker: {
  metadata: { kind: "string" };
  parse(value: unknown): unknown;
  [SCHEMA_PROTOCOL_MARKER]?: {
    protocolVersion: "1";
    canonicalVersion: "1";
    metadata: { kind: "number" };
    parse(value: unknown): unknown;
  };
};
export const ambiguous = optionalMarker;
class ProtocolPrototype {
  get [SCHEMA_PROTOCOL_MARKER]() {
    return { protocolVersion: "1" as const, canonicalVersion: "1" as const, metadata: { kind: "string" as const }, parse: parser };
  }
}
export const directProtocolGetter = new ProtocolPrototype();
export const inheritedProtocol = new class extends ProtocolPrototype {}();
class LegacyPrototype {
  metadata = { kind: "string" as const };
  parse(value: unknown) { return value; }
}
export const legacyPrototype = new LegacyPrototype();
interface StructuralLegacy {
  metadata: { kind: "string" };
  parse(value: unknown): unknown;
}
declare const structuralLegacy: StructuralLegacy;
export const interfaceOnly = structuralLegacy;
class OwnLegacyFields {
  metadata = { kind: "number" as const };
  parse = parser;
}
export const ownLegacyFields = new OwnLegacyFields();
class OwnProtocolField {
  [SCHEMA_PROTOCOL_MARKER] = {
    protocolVersion: "1" as const,
    canonicalVersion: "1" as const,
    metadata: { kind: "boolean" as const },
    parse: parser,
  };
}
export const ownProtocolField = new OwnProtocolField();
class DescriptorClass {
  protocolVersion = "1" as const;
  canonicalVersion = "1" as const;
  metadata = { kind: "string" as const };
  parse = parser;
}
export const classDescriptor = { [SCHEMA_PROTOCOL_MARKER]: new DescriptorClass() };
export const wrongProtocolVersion = {
  [SCHEMA_PROTOCOL_MARKER]: { protocolVersion: "2" as const, canonicalVersion: "1" as const, metadata: { kind: "string" as const }, parse: parser },
};
export const wrongCanonicalVersion = {
  [SCHEMA_PROTOCOL_MARKER]: { protocolVersion: "1" as const, canonicalVersion: 1 as const, metadata: { kind: "string" as const }, parse: parser },
};
export const malformedParser = {
  [SCHEMA_PROTOCOL_MARKER]: { protocolVersion: "1" as const, canonicalVersion: "1" as const, metadata: { kind: "string" as const }, parse: "not callable" },
};
export const malformedDescriptor = { [SCHEMA_PROTOCOL_MARKER]: "not an object" };
export const missingDescriptorMetadata = {
  [SCHEMA_PROTOCOL_MARKER]: { protocolVersion: "1" as const, canonicalVersion: "1" as const, parse: parser },
};
`,
    });

    assert.deepEqual(
      metadataOf(extractRuntimeSchemaFacet(fixture.checker, fixture.expression("protocol"), "protocol")),
      { kind: "string" },
    );
    assert.deepEqual(
      metadataOf(extractRuntimeSchemaFacet(fixture.checker, fixture.expression("legacy"), "legacy")),
      { kind: "boolean" },
    );
    assert.deepEqual(
      metadataOf(extractRuntimeSchemaFacet(fixture.checker, fixture.expression("ownLegacyFields"), "ownLegacyFields")),
      { kind: "number" },
    );
    assert.deepEqual(
      metadataOf(extractRuntimeSchemaFacet(fixture.checker, fixture.expression("ownProtocolField"), "ownProtocolField")),
      { kind: "boolean" },
    );

    const invalid = new Map([
      ["extraLegacy", "extraLegacy"],
      ["publicDescriptorOnly", 'publicDescriptorOnly."typescript-on-rails.schema"'],
      ["directProtocolGetter", 'directProtocolGetter."typescript-on-rails.schema"'],
      ["legacyPrototype", 'legacyPrototype."parse"'],
      ["interfaceOnly", 'interfaceOnly."metadata"'],
      ["classDescriptor", 'classDescriptor."typescript-on-rails.schema"'],
      ["ambiguous", 'ambiguous."typescript-on-rails.schema"'],
      ["inheritedProtocol", 'inheritedProtocol."typescript-on-rails.schema"'],
      ["wrongProtocolVersion", 'wrongProtocolVersion."typescript-on-rails.schema"."protocolVersion"'],
      ["wrongCanonicalVersion", 'wrongCanonicalVersion."typescript-on-rails.schema"."canonicalVersion"'],
      ["malformedParser", 'malformedParser."typescript-on-rails.schema"."parse"'],
      ["malformedDescriptor", 'malformedDescriptor."typescript-on-rails.schema"'],
      ["missingDescriptorMetadata", 'missingDescriptorMetadata."typescript-on-rails.schema"."metadata"'],
    ]);
    for (const [name, expectedPath] of invalid) {
      const facet = extractRuntimeSchemaFacet(fixture.checker, fixture.expression(name), name);
      assert.equal(facet.status, "unresolved", name);
      if (facet.status === "unresolved") {
        assert.equal(facet.diagnostic.code, "SC004", name);
        assert.equal(facet.diagnostic.path, expectedPath, name);
      }
    }
  });

  it("rejects non-plain metadata nodes, accessors, payloads, and nested field maps", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
const parser = (value: unknown) => value;
class MetadataClass { kind = "string" as const; }
export const classMetadata = { metadata: new MetadataClass(), parse: parser };
export const getterMetadata = {
  metadata: { get kind() { return "string" as const; } },
  parse: parser,
};
class PayloadClass { label = "payload" as const; }
export const classPayload = {
  metadata: {
    kind: "extension" as const,
    namespace: "test" as const,
    name: "class-payload" as const,
    version: "1" as const,
    payload: new PayloadClass(),
    underlying: { kind: "string" as const },
  },
  parse: parser,
};
class FieldsClass { value = { kind: "string" as const }; }
class InheritedFields extends FieldsClass {}
export const classFields = {
  metadata: { kind: "object" as const, fields: new FieldsClass() },
  parse: parser,
};
export const inheritedFields = {
  metadata: { kind: "object" as const, fields: new InheritedFields() },
  parse: parser,
};
export const getterFields = {
  metadata: {
    kind: "object" as const,
    fields: { get value() { return { kind: "string" as const }; } },
  },
  parse: parser,
};
`,
    });

    const expected = new Map([
      ["classMetadata", ["SC002", 'classMetadata."metadata"']],
      ["getterMetadata", ["SC002", 'getterMetadata."metadata"."kind"']],
      ["classPayload", ["SC003", 'classPayload."metadata"."payload"']],
      ["classFields", ["SC002", 'classFields."metadata"."fields"']],
      ["inheritedFields", ["SC002", 'inheritedFields."metadata"."fields"']],
      ["getterFields", ["SC002", 'getterFields."metadata"."fields"."value"']],
    ] as const);
    for (const [name, [code, expectedPath]] of expected) {
      const facet = extractRuntimeSchemaFacet(fixture.checker, fixture.expression(name), name);
      assert.equal(facet.status, "unresolved", name);
      if (facet.status === "unresolved") {
        assert.equal(facet.diagnostic.code, code, name);
        assert.equal(facet.diagnostic.path, expectedPath, name);
      }
    }
  });

  it("rejects numeric index signatures on every finite schema map surface", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
import { string } from "typescript-on-rails";
declare const numericMetadata: { [key: number]: unknown; kind: "string" };
declare const numericPayload: { [key: number]: "value"; safe: "yes" };
declare const numericFields: { [key: number]: ReturnType<typeof string>; safe: ReturnType<typeof string> };
declare const numericOperations: { [key: number]: { input: ReturnType<typeof string>; output: ReturnType<typeof string> }; safe: { input: ReturnType<typeof string>; output: ReturnType<typeof string> } };
export const metadataSchema = { metadata: numericMetadata, parse(value: unknown) { return value; } };
export const jsonSchema = {
  metadata: { kind: "extension" as const, namespace: "test" as const, name: "numeric" as const, version: "1" as const, payload: numericPayload, underlying: { kind: "string" as const } },
  parse(value: unknown) { return value; },
};
export const fields = numericFields;
export const operations = numericOperations;
`,
    });

    const metadata = extractRuntimeSchemaFacet(fixture.checker, fixture.expression("metadataSchema"), "metadataSchema");
    assert.equal(metadata.status, "unresolved");
    if (metadata.status === "unresolved") assert.equal(metadata.diagnostic.code, "SC002");
    const json = extractRuntimeSchemaFacet(fixture.checker, fixture.expression("jsonSchema"), "jsonSchema");
    assert.equal(json.status, "unresolved");
    if (json.status === "unresolved") assert.equal(json.diagnostic.code, "SC003");
    const fields = extractSchemaFieldsFacet(fixture.checker, fixture.expression("fields"), "fields");
    assert.equal(fields.status, "unresolved");
    const operations = extractAdapterOperationsFacet(fixture.checker, fixture.expression("operations"), "operations");
    assert.equal(operations.status, "unresolved");
  });

  it("requires computed own-key syntax for __proto__ fields and JSON properties", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
import { string } from "typescript-on-rails";
export const quotedFields = { "__proto__": string(), safe: string() };
export const quotedMetadata = {
  metadata: { kind: "object" as const, fields: { "__proto__": { kind: "string" as const }, safe: { kind: "string" as const } } },
  parse(value: unknown) { return value; },
};
export const quotedJson = {
  metadata: { kind: "extension" as const, namespace: "test" as const, name: "proto" as const, version: "1" as const, payload: { "__proto__": { polluted: true }, safe: "yes" as const }, underlying: { kind: "string" as const } },
  parse(value: unknown) { return value; },
};
`,
    });

    const fields = extractSchemaFieldsFacet(fixture.checker, fixture.expression("quotedFields"), "quotedFields");
    assert.equal(fields.status, "unresolved");
    const metadata = extractRuntimeSchemaFacet(fixture.checker, fixture.expression("quotedMetadata"), "quotedMetadata");
    assert.equal(metadata.status, "unresolved");
    const json = extractRuntimeSchemaFacet(fixture.checker, fixture.expression("quotedJson"), "quotedJson");
    assert.equal(json.status, "unresolved");
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
  });

  it("requires adapter input and output while retaining present invalid schemas", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
import { string } from "typescript-on-rails";
export const missingInput = { operation: { output: string() } };
export const missingOutput = { operation: { input: string() } };
export const optionalInput = { operation: {} as { input?: ReturnType<typeof string>; output: ReturnType<typeof string> } };
`,
    });

    const missingInput = extractAdapterOperationsFacet(fixture.checker, fixture.expression("missingInput"), "missingInput");
    assert.equal(missingInput.status, "unresolved");
    if (missingInput.status === "unresolved") assert.equal(missingInput.diagnostic.path, 'missingInput."operation"."input"');
    const missingOutput = extractAdapterOperationsFacet(fixture.checker, fixture.expression("missingOutput"), "missingOutput");
    assert.equal(missingOutput.status, "unresolved");
    if (missingOutput.status === "unresolved") assert.equal(missingOutput.diagnostic.path, 'missingOutput."operation"."output"');
    const optionalInput = extractAdapterOperationsFacet(fixture.checker, fixture.expression("optionalInput"), "optionalInput");
    assert.equal(optionalInput.status, "unresolved");
    if (optionalInput.status === "unresolved") assert.equal(optionalInput.diagnostic.path, 'optionalInput."operation"."input"');
  });

  it("accepts whitespace-only nonempty extension identifiers like runtime normalization", async () => {
    const fixture = await checkedFixture({
      "src/features/contracts/index.ts": `
export const whitespace = {
  metadata: { kind: "extension" as const, namespace: " " as const, name: "\\t" as const, version: "\\n" as const, payload: null, underlying: { kind: "string" as const } },
  parse(value: unknown) { return value; },
};
`,
    });

    assert.deepEqual(
      metadataOf(extractRuntimeSchemaFacet(fixture.checker, fixture.expression("whitespace"), "whitespace")),
      { kind: "extension", namespace: " ", name: "\t", version: "\n", payload: null, underlying: { kind: "string" } },
    );
  });
});

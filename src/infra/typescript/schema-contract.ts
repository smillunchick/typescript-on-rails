import { fileURLToPath } from "node:url";
import ts from "typescript";

import type {
  AdapterOperationFacet,
  AdapterOperationsFacet,
  DeclaredRuntimeSchemaFacet,
  RuntimeSchemaFacet,
  TypeContractDiagnostic,
} from "../../features/architecture/manifest.js";
import {
  architecture,
  CANONICAL_SCHEMA_VERSION,
  SCHEMA_PROTOCOL_MARKER,
  SCHEMA_PROTOCOL_VERSION,
  type CanonicalJsonValue,
  type LiteralValue,
  type SchemaMetadata,
} from "../../features/runtime/index.js";

architecture.allow({
  rule: "boring-typescript",
  reason: "TypeScript 5.9 does not narrow compiler types after tuple and literal flag checks.",
});

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const frameworkRoot = fileURLToPath(new URL("../../../", import.meta.url));
const frameworkSchemaProtocolFiles = new Set([
  `${frameworkRoot}src/features/runtime/schema-protocol.ts`,
  `${frameworkRoot}src/features/runtime/schema-protocol.d.ts`,
  `${frameworkRoot}dist/features/runtime/schema-protocol.ts`,
  `${frameworkRoot}dist/features/runtime/schema-protocol.d.ts`,
]);
const frameworkSchemaMetadataFiles = new Set([
  ...frameworkSchemaProtocolFiles,
  `${frameworkRoot}src/features/runtime/schema.ts`,
  `${frameworkRoot}src/features/runtime/schema.d.ts`,
  `${frameworkRoot}dist/features/runtime/schema.ts`,
  `${frameworkRoot}dist/features/runtime/schema.d.ts`,
]);

const failures = {
  opaque: ["SC001", "The schema metadata type is widened or opaque"],
  metadata: ["SC002", "The schema metadata type is invalid or unknown"],
  json: ["SC003", "The extension payload is not canonical JSON"],
  schema: ["SC004", "The value is not a structural schema"],
  recursion: ["SC005", "Recursive schema metadata is unsupported"],
} as const;

type FailureName = keyof typeof failures;

class SchemaContractFailure extends Error {
  constructor(readonly diagnostic: TypeContractDiagnostic) {
    super(diagnostic.message);
  }
}

function fail(name: FailureName, path: string, checker: ts.TypeChecker, type?: ts.Type): never {
  const [code, message] = failures[name];
  throw new SchemaContractFailure({
    code,
    path,
    message,
    ...(type === undefined ? {} : { detail: checker.typeToString(type, undefined, ts.TypeFormatFlags.NoTruncation) }),
  });
}

function propertyPath(path: string, name: string): string {
  return `${path}.${JSON.stringify(name)}`;
}

function unresolved(diagnostic: TypeContractDiagnostic): DeclaredRuntimeSchemaFacet {
  return {
    status: "unresolved",
    provenance: "declared-schema",
    validator: "declared",
    diagnostic,
  };
}

function unresolvedFromFailure(error: SchemaContractFailure): DeclaredRuntimeSchemaFacet {
  return unresolved(error.diagnostic);
}

function notDeclared(): RuntimeSchemaFacet {
  return { status: "not-declared", validator: "not-declared" };
}

function isOpaque(type: ts.Type): boolean {
  return (type.flags & (
    ts.TypeFlags.Any
    | ts.TypeFlags.Unknown
    | ts.TypeFlags.TypeParameter
    | ts.TypeFlags.Conditional
    | ts.TypeFlags.IndexedAccess
    | ts.TypeFlags.Substitution
  )) !== 0 || type.isUnion() || type.isIntersection();
}

function propertyType(checker: ts.TypeChecker, property: ts.Symbol, anchor: ts.Node): ts.Type {
  return checker.getTypeOfSymbolAtLocation(
    property,
    property.valueDeclaration ?? property.declarations?.[0] ?? anchor,
  );
}

function requiredProperty(
  checker: ts.TypeChecker,
  type: ts.Type,
  name: string,
  anchor: ts.Node,
  path: string,
  failure: FailureName = "metadata",
): ts.Type {
  const property = type.getProperty(name);
  if (property === undefined || (property.flags & ts.SymbolFlags.Optional) !== 0) {
    fail(failure, propertyPath(path, name), checker, property === undefined ? type : propertyType(checker, property, anchor));
  }
  return propertyType(checker, property, anchor);
}

function hasIndexSignature(checker: ts.TypeChecker, type: ts.Type): boolean {
  return checker.getIndexTypeOfType(type, ts.IndexKind.String) !== undefined
    || checker.getIndexTypeOfType(type, ts.IndexKind.Number) !== undefined;
}

function isOwnCheckerVisibleProperty(type: ts.Type, property: ts.Symbol): boolean {
  const typeDeclarations = type.getSymbol()?.declarations;
  const propertyDeclarations = property.declarations;
  return typeDeclarations !== undefined
    && propertyDeclarations !== undefined
    && propertyDeclarations.some((declaration) => typeDeclarations.some((typeDeclaration) => typeDeclaration === declaration.parent));
}

function hasStaticModifier(declaration: ts.Declaration): boolean {
  return ts.canHaveModifiers(declaration)
    && ts.getModifiers(declaration)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) === true;
}

function isOwnRuntimeDataDeclaration(declaration: ts.Declaration): boolean {
  if (
    ts.isPropertyAssignment(declaration)
    || ts.isShorthandPropertyAssignment(declaration)
    || ts.isMethodDeclaration(declaration)
  ) return ts.isObjectLiteralExpression(declaration.parent);
  return ts.isPropertyDeclaration(declaration)
    && declaration.initializer !== undefined
    && !hasStaticModifier(declaration);
}

function isFrameworkSchemaProtocolDeclaration(declaration: ts.Declaration, interfaceName: string): boolean {
  const parent = declaration.parent;
  if (!ts.isInterfaceDeclaration(parent) || parent.name.text !== interfaceName) return false;
  return frameworkSchemaProtocolFiles.has(declaration.getSourceFile().fileName);
}

function isProvenOwnRuntimeDataProperty(
  type: ts.Type,
  property: ts.Symbol,
  frameworkInterface?: string,
): boolean {
  if ((property.flags & ts.SymbolFlags.Optional) !== 0) return false;
  const declarations = property.declarations;
  if (declarations === undefined) return false;
  if (
    frameworkInterface !== undefined
    && declarations.every((declaration) => isFrameworkSchemaProtocolDeclaration(declaration, frameworkInterface))
  ) return true;
  return isOwnCheckerVisibleProperty(type, property)
    && declarations.every(isOwnRuntimeDataDeclaration);
}

function isObjectLiteralBacked(type: ts.Type): boolean {
  return type.getSymbol()?.declarations?.some(ts.isObjectLiteralExpression) === true;
}

const frameworkSchemaMetadataAliases = new Set([
  "CanonicalJsonValue",
  "LiteralValue",
  "ObjectSchemaMetadata",
  "SchemaMetadata",
  "SchemaMetadataOf",
]);

function isFrameworkSchemaMetadataDeclaration(declaration: ts.Declaration): boolean {
  if (!frameworkSchemaMetadataFiles.has(declaration.getSourceFile().fileName)) return false;
  if (ts.isTypeAliasDeclaration(declaration)) {
    return frameworkSchemaMetadataAliases.has(declaration.name.text);
  }
  if (!ts.isTypeLiteralNode(declaration) && !ts.isMappedTypeNode(declaration)) return false;

  let child: ts.Node = declaration;
  for (let current = declaration.parent; current !== undefined; child = current, current = current.parent) {
    if (ts.isTypeAliasDeclaration(current)) {
      return frameworkSchemaMetadataAliases.has(current.name.text);
    }
    if (
      ts.isTypeReferenceNode(current)
      && ts.isIdentifier(current.typeName)
      && current.typeName.text === "NormalizedSchema"
    ) {
      return current.typeArguments?.[1] === child;
    }
  }
  return false;
}

function isFrameworkSchemaMetadataType(type: ts.Type): boolean {
  const declarations = [
    ...(type.getSymbol()?.declarations ?? []),
    ...(type.aliasSymbol?.declarations ?? []),
  ];
  return declarations.some(isFrameworkSchemaMetadataDeclaration);
}

function isFrameworkNormalizedSchemaMarker(property: ts.Symbol): boolean {
  const declarations = property.declarations;
  return declarations !== undefined
    && declarations.length > 0
    && declarations.every((declaration) => isFrameworkSchemaProtocolDeclaration(declaration, "NormalizedSchema"));
}

function requirePlainOwnObject(
  checker: ts.TypeChecker,
  type: ts.Type,
  properties: Iterable<ts.Symbol>,
  anchor: ts.Node,
  path: string,
  failure: FailureName,
): void {
  if (!isObjectLiteralBacked(type)) fail(failure, path, checker, type);
  for (const property of properties) {
    if (!isProvenOwnRuntimeDataProperty(type, property)) {
      fail(failure, propertyPath(path, property.name), checker, propertyType(checker, property, anchor));
    }
  }
}

function hasProvenOwnProtoDeclaration(property: ts.Symbol): boolean {
  if (property.name !== "__proto__") return true;
  const declarations = property.declarations;
  return declarations !== undefined && declarations.length > 0 && declarations.every((declaration) => {
    const name = (declaration as ts.Declaration & { readonly name?: ts.DeclarationName }).name;
    return name !== undefined && ts.isComputedPropertyName(name);
  });
}

function exactProperties(
  checker: ts.TypeChecker,
  type: ts.Type,
  required: readonly string[],
  optional: readonly string[],
  anchor: ts.Node,
  path: string,
  failure: FailureName = "metadata",
): ReadonlyMap<string, ts.Symbol> {
  if (isOpaque(type)) fail(failure === "schema" ? "schema" : "opaque", path, checker, type);
  if ((type.flags & ts.TypeFlags.Object) === 0) fail(failure, path, checker, type);
  if (hasIndexSignature(checker, type)) fail(failure, path, checker, type);

  const properties = checker.getPropertiesOfType(type);
  const allowed = new Set([...required, ...optional]);
  if (properties.some((property) => !allowed.has(property.name))) fail(failure, path, checker, type);
  const byName = new Map(properties.map((property) => [property.name, property]));
  for (const name of required) {
    const property = byName.get(name);
    if (property === undefined || (property.flags & ts.SymbolFlags.Optional) !== 0) {
      fail(failure, propertyPath(path, name), checker, property === undefined ? type : propertyType(checker, property, anchor));
    }
  }
  for (const name of optional) {
    const property = byName.get(name);
    if (property !== undefined && (property.flags & ts.SymbolFlags.Optional) !== 0) {
      fail(failure, propertyPath(path, name), checker, propertyType(checker, property, anchor));
    }
  }
  return byName;
}

function stringLiteral(checker: ts.TypeChecker, type: ts.Type, path: string, failure: FailureName): string {
  if (!type.isStringLiteral()) fail(failure, path, checker, type);
  return type.value;
}

function booleanLiteral(checker: ts.TypeChecker, type: ts.Type, path: string, failure: FailureName): boolean {
  if ((type.flags & ts.TypeFlags.BooleanLiteral) === 0) fail(failure, path, checker, type);
  // TypeScript 5.9 exposes BooleanLiteral through intrinsicName but does not publish a narrower interface.
  return (type as ts.Type & { readonly intrinsicName: "true" | "false" }).intrinsicName === "true";
}

function numberLiteral(checker: ts.TypeChecker, type: ts.Type, path: string, failure: FailureName): number {
  if (!type.isNumberLiteral()) fail(failure, path, checker, type);
  if (!Number.isFinite(type.value)) fail(failure, path, checker, type);
  return Object.is(type.value, -0) ? 0 : type.value;
}

function literalValue(checker: ts.TypeChecker, type: ts.Type, path: string, failure: FailureName): LiteralValue {
  if ((type.flags & ts.TypeFlags.Null) !== 0) return null;
  if (type.isStringLiteral()) return type.value;
  if (type.isNumberLiteral()) return numberLiteral(checker, type, path, failure);
  if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) return booleanLiteral(checker, type, path, failure);
  fail(failure, path, checker, type);
}

function tupleTypes(checker: ts.TypeChecker, type: ts.Type, path: string, failure: FailureName): readonly ts.Type[] {
  if (!checker.isTupleType(type)) fail(failure, path, checker, type);
  // isTupleType does not narrow to TypeReference in the public TypeScript 5.9 declarations.
  const reference = type as ts.TypeReference;
  const target = reference.target as ts.TupleType;
  if (target.elementFlags.some((flag) => (flag & (ts.ElementFlags.Optional | ts.ElementFlags.Rest | ts.ElementFlags.Variadic)) !== 0)) {
    fail(failure, path, checker, type);
  }
  return checker.getTypeArguments(reference);
}

function concreteObjectProperties(
  checker: ts.TypeChecker,
  type: ts.Type,
  anchor: ts.Node,
  path: string,
  failure: FailureName,
  requireSourceProvenance: boolean,
  requirePlainObject: boolean,
): readonly ts.Symbol[] {
  if (isOpaque(type)) fail(failure === "json" ? "json" : "opaque", path, checker, type);
  if ((type.flags & ts.TypeFlags.Object) === 0 || checker.isArrayType(type) || checker.isTupleType(type)) {
    fail(failure, path, checker, type);
  }
  if (hasIndexSignature(checker, type)) fail(failure, path, checker, type);
  const properties = checker.getPropertiesOfType(type).sort((left, right) => compareText(left.name, right.name));
  if (requireSourceProvenance && requirePlainObject && !isObjectLiteralBacked(type)) fail(failure, path, checker, type);
  const classBacked = type.getSymbol()?.declarations?.some(ts.isClassDeclaration) === true;
  const runtimeEntries: ts.Symbol[] = [];
  for (const property of properties) {
    if (
      (property.flags & ts.SymbolFlags.Optional) !== 0
      || property.name.startsWith("__@")
      || !hasProvenOwnProtoDeclaration(property)
    ) {
      fail(failure, propertyPath(path, property.name), checker, propertyType(checker, property, anchor));
    }
    if (requireSourceProvenance && !isProvenOwnRuntimeDataProperty(type, property)) {
      const declarations = property.declarations;
      const inheritedInstanceField = !requirePlainObject
        && classBacked
        && declarations !== undefined
        && declarations.length > 0
        && declarations.every(isOwnRuntimeDataDeclaration);
      if (!inheritedInstanceField) {
        if (!requirePlainObject && classBacked) continue;
        fail(failure, propertyPath(path, property.name), checker, propertyType(checker, property, anchor));
      }
    }
    runtimeEntries.push(property);
  }
  return runtimeEntries;
}

function setOwn<TValue>(target: Record<string, TValue>, key: string, value: TValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

class SchemaMetadataLowerer {
  private readonly activeMetadata = new Set<ts.Type>();
  private readonly activeJson = new Set<ts.Type>();

  constructor(private readonly checker: ts.TypeChecker, private readonly anchor: ts.Node) {}

  schema(type: ts.Type, path: string): SchemaMetadata {
    if (isOpaque(type)) fail("opaque", path, this.checker, type);
    if ((type.flags & ts.TypeFlags.Object) === 0) fail("schema", path, this.checker, type);

    const markerPath = propertyPath(path, SCHEMA_PROTOCOL_MARKER);
    const marker = type.getProperty(SCHEMA_PROTOCOL_MARKER);
    if (marker !== undefined) {
      if (!isProvenOwnRuntimeDataProperty(type, marker, "NormalizedSchema")) {
        fail("schema", markerPath, this.checker, propertyType(this.checker, marker, this.anchor));
      }
      const descriptor = propertyType(this.checker, marker, this.anchor);
      const trustedFrameworkDescriptor = isFrameworkNormalizedSchemaMarker(marker);
      if (
        isOpaque(descriptor)
        || (descriptor.flags & ts.TypeFlags.Object) === 0
        || this.checker.isArrayType(descriptor)
        || this.checker.isTupleType(descriptor)
        || (!trustedFrameworkDescriptor && !isObjectLiteralBacked(descriptor))
      ) {
        fail("schema", markerPath, this.checker, descriptor);
      }
      const protocolVersion = requiredProperty(
        this.checker,
        descriptor,
        "protocolVersion",
        this.anchor,
        markerPath,
        "schema",
      );
      if (!protocolVersion.isStringLiteral() || protocolVersion.value !== SCHEMA_PROTOCOL_VERSION) {
        fail("schema", propertyPath(markerPath, "protocolVersion"), this.checker, protocolVersion);
      }
      const canonicalVersion = requiredProperty(
        this.checker,
        descriptor,
        "canonicalVersion",
        this.anchor,
        markerPath,
        "schema",
      );
      if (!canonicalVersion.isStringLiteral() || canonicalVersion.value !== CANONICAL_SCHEMA_VERSION) {
        fail("schema", propertyPath(markerPath, "canonicalVersion"), this.checker, canonicalVersion);
      }
      const descriptorParse = requiredProperty(
        this.checker,
        descriptor,
        "parse",
        this.anchor,
        markerPath,
        "schema",
      );
      if (descriptorParse.getCallSignatures().length === 0) {
        fail("schema", propertyPath(markerPath, "parse"), this.checker, descriptorParse);
      }
      const descriptorMetadata = requiredProperty(
        this.checker,
        descriptor,
        "metadata",
        this.anchor,
        markerPath,
        "schema",
      );
      if (!trustedFrameworkDescriptor) {
        requirePlainOwnObject(
          this.checker,
          descriptor,
          [
            descriptor.getProperty("protocolVersion")!,
            descriptor.getProperty("canonicalVersion")!,
            descriptor.getProperty("parse")!,
            descriptor.getProperty("metadata")!,
          ],
          this.anchor,
          markerPath,
          "schema",
        );
      }
      return this.metadata(descriptorMetadata, propertyPath(markerPath, "metadata"));
    }

    const properties = exactProperties(
      this.checker,
      type,
      ["metadata", "parse"],
      [],
      this.anchor,
      path,
      "schema",
    );
    const parseProperty = properties.get("parse")!;
    const metadataProperty = properties.get("metadata")!;
    if (!isProvenOwnRuntimeDataProperty(type, metadataProperty)) {
      fail("schema", propertyPath(path, "metadata"), this.checker, propertyType(this.checker, metadataProperty, this.anchor));
    }
    if (!isProvenOwnRuntimeDataProperty(type, parseProperty)) {
      fail("schema", propertyPath(path, "parse"), this.checker, propertyType(this.checker, parseProperty, this.anchor));
    }
    const parseType = propertyType(this.checker, parseProperty, this.anchor);
    if (parseType.getCallSignatures().length === 0) fail("schema", propertyPath(path, "parse"), this.checker, parseType);
    return this.metadata(propertyType(this.checker, metadataProperty, this.anchor), propertyPath(path, "metadata"));
  }

  private metadataProperties(
    type: ts.Type,
    required: readonly string[],
    optional: readonly string[],
    path: string,
  ): ReadonlyMap<string, ts.Symbol> {
    const properties = exactProperties(this.checker, type, required, optional, this.anchor, path);
    if (!isFrameworkSchemaMetadataType(type)) {
      requirePlainOwnObject(this.checker, type, properties.values(), this.anchor, path, "metadata");
    }
    return properties;
  }

  metadata(type: ts.Type, path: string): SchemaMetadata {
    if (this.activeMetadata.has(type)) fail("recursion", path, this.checker, type);
    this.activeMetadata.add(type);
    try {
      if (isOpaque(type)) fail("opaque", path, this.checker, type);
      const trustedFrameworkMetadata = isFrameworkSchemaMetadataType(type);
      if (!trustedFrameworkMetadata && !isObjectLiteralBacked(type)) fail("metadata", path, this.checker, type);
      const kindProperty = type.getProperty("kind");
      if (
        !trustedFrameworkMetadata
        && kindProperty !== undefined
        && !isProvenOwnRuntimeDataProperty(type, kindProperty)
      ) fail("metadata", propertyPath(path, "kind"), this.checker, propertyType(this.checker, kindProperty, this.anchor));
      const kindType = requiredProperty(this.checker, type, "kind", this.anchor, path);
      const kind = stringLiteral(this.checker, kindType, propertyPath(path, "kind"), "opaque");
      switch (kind) {
        case "string":
        case "number":
        case "boolean":
        case "date":
          this.metadataProperties(type, ["kind"], [], path);
          return { kind };
        case "id": {
          const properties = this.metadataProperties(type, ["kind"], ["entity"], path);
          const entity = properties.get("entity");
          if (entity === undefined) return { kind: "id" };
          const value = stringLiteral(
            this.checker,
            propertyType(this.checker, entity, this.anchor),
            propertyPath(path, "entity"),
            "metadata",
          );
          if (value.length === 0) fail("metadata", propertyPath(path, "entity"), this.checker, propertyType(this.checker, entity, this.anchor));
          return { kind: "id", entity: value };
        }
        case "money": {
          this.metadataProperties(type, ["kind", "currency"], [], path);
          const currency = stringLiteral(
            this.checker,
            requiredProperty(this.checker, type, "currency", this.anchor, path),
            propertyPath(path, "currency"),
            "metadata",
          );
          if (currency !== "minor-unit") fail("metadata", propertyPath(path, "currency"), this.checker, type);
          return { kind: "money", currency: "minor-unit" };
        }
        case "enum": {
          this.metadataProperties(type, ["kind", "values"], [], path);
          const valuesType = requiredProperty(this.checker, type, "values", this.anchor, path);
          const entries = tupleTypes(this.checker, valuesType, propertyPath(path, "values"), "metadata");
          if (entries.length === 0) fail("metadata", propertyPath(path, "values"), this.checker, valuesType);
          return {
            kind: "enum",
            values: entries.map((entry, index) => literalValue(
              this.checker,
              entry,
              `${propertyPath(path, "values")}[${index}]`,
              "metadata",
            )),
          };
        }
        case "literal":
          this.metadataProperties(type, ["kind", "value"], [], path);
          return {
            kind: "literal",
            value: literalValue(
              this.checker,
              requiredProperty(this.checker, type, "value", this.anchor, path),
              propertyPath(path, "value"),
              "metadata",
            ),
          };
        case "optional":
          this.metadataProperties(type, ["kind", "inner"], [], path);
          return {
            kind: "optional",
            inner: this.metadata(
              requiredProperty(this.checker, type, "inner", this.anchor, path),
              propertyPath(path, "inner"),
            ),
          };
        case "array":
          this.metadataProperties(type, ["kind", "items"], [], path);
          return {
            kind: "array",
            items: this.metadata(
              requiredProperty(this.checker, type, "items", this.anchor, path),
              propertyPath(path, "items"),
            ),
          };
        case "object": {
          this.metadataProperties(type, ["kind", "fields"], [], path);
          const fieldsType = requiredProperty(this.checker, type, "fields", this.anchor, path);
          const properties = concreteObjectProperties(
            this.checker,
            fieldsType,
            this.anchor,
            propertyPath(path, "fields"),
            "metadata",
            !isFrameworkSchemaMetadataType(fieldsType),
            true,
          );
          const fields: Record<string, SchemaMetadata> = {};
          for (const property of properties) {
            setOwn(fields, property.name, this.metadata(
              propertyType(this.checker, property, this.anchor),
              propertyPath(propertyPath(path, "fields"), property.name),
            ));
          }
          return { kind: "object", fields };
        }
        case "extension": {
          this.metadataProperties(
            type,
            ["kind", "namespace", "name", "version", "payload", "underlying"],
            [],
            path,
          );
          const requiredText = (name: "namespace" | "name" | "version"): string => {
            const valueType = requiredProperty(this.checker, type, name, this.anchor, path);
            const value = stringLiteral(this.checker, valueType, propertyPath(path, name), "metadata");
            if (value.length === 0) fail("metadata", propertyPath(path, name), this.checker, valueType);
            return value;
          };
          return {
            kind: "extension",
            namespace: requiredText("namespace"),
            name: requiredText("name"),
            version: requiredText("version"),
            payload: this.json(
              requiredProperty(this.checker, type, "payload", this.anchor, path),
              propertyPath(path, "payload"),
            ),
            underlying: this.metadata(
              requiredProperty(this.checker, type, "underlying", this.anchor, path),
              propertyPath(path, "underlying"),
            ),
          };
        }
        default:
          fail("metadata", propertyPath(path, "kind"), this.checker, kindType);
      }
    } finally {
      this.activeMetadata.delete(type);
    }
  }

  private json(type: ts.Type, path: string): CanonicalJsonValue {
    if ((type.flags & ts.TypeFlags.Null) !== 0) return null;
    if (type.isStringLiteral()) return type.value;
    if (type.isNumberLiteral()) return numberLiteral(this.checker, type, path, "json");
    if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) return booleanLiteral(this.checker, type, path, "json");
    if (isOpaque(type)) fail("json", path, this.checker, type);
    if (this.activeJson.has(type)) fail("recursion", path, this.checker, type);
    this.activeJson.add(type);
    try {
      if (this.checker.isTupleType(type)) {
        return tupleTypes(this.checker, type, path, "json").map((entry, index) => this.json(
          entry,
          `${path}[${index}]`,
        ));
      }
      const properties = concreteObjectProperties(
        this.checker,
        type,
        this.anchor,
        path,
        "json",
        !isFrameworkSchemaMetadataType(type),
        true,
      );
      const output: Record<string, CanonicalJsonValue> = {};
      for (const property of properties) {
        setOwn(output, property.name, this.json(
          propertyType(this.checker, property, this.anchor),
          propertyPath(path, property.name),
        ));
      }
      return output;
    } finally {
      this.activeJson.delete(type);
    }
  }
}

function schemaFacetFromType(checker: ts.TypeChecker, type: ts.Type, anchor: ts.Node, path: string): DeclaredRuntimeSchemaFacet {
  try {
    return {
      status: "resolved",
      provenance: "declared-schema",
      validator: "declared",
      metadata: new SchemaMetadataLowerer(checker, anchor).schema(type, path),
    };
  } catch (error) {
    if (error instanceof SchemaContractFailure) return unresolvedFromFailure(error);
    throw error;
  }
}

/** Lower one schema expression from checker-visible structure without loading application code. */
export function extractRuntimeSchemaFacet(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  path: string,
): DeclaredRuntimeSchemaFacet;
export function extractRuntimeSchemaFacet(
  checker: ts.TypeChecker,
  expression: undefined,
  path: string,
): Extract<RuntimeSchemaFacet, { readonly status: "not-declared" }>;
export function extractRuntimeSchemaFacet(
  checker: ts.TypeChecker,
  expression: ts.Expression | undefined,
  path: string,
): RuntimeSchemaFacet;
export function extractRuntimeSchemaFacet(
  checker: ts.TypeChecker,
  expression: ts.Expression | undefined,
  path: string,
): RuntimeSchemaFacet {
  if (expression === undefined) return notDeclared();
  return schemaFacetFromType(checker, checker.getTypeAtLocation(expression), expression, path);
}

/** Lower a model's bare schema-fields object to one canonical object schema facet. */
export function extractSchemaFieldsFacet(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  path: string,
): DeclaredRuntimeSchemaFacet {
  try {
    const type = checker.getTypeAtLocation(expression);
    const properties = concreteObjectProperties(checker, type, expression, path, "metadata", true, false);
    const lowerer = new SchemaMetadataLowerer(checker, expression);
    const fields: Record<string, SchemaMetadata> = {};
    for (const property of properties) {
      const fieldPath = propertyPath(path, property.name);
      const fieldType = propertyType(checker, property, expression);
      setOwn(fields, property.name, lowerer.schema(fieldType, fieldPath));
    }
    return {
      status: "resolved",
      provenance: "declared-schema",
      validator: "declared",
      metadata: { kind: "object", fields },
    };
  } catch (error) {
    if (error instanceof SchemaContractFailure) return unresolvedFromFailure(error);
    throw error;
  }
}

/** Lower either one declared schema or a bare field map without executing source. */
export function extractSchemaOrFieldsFacet(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  path: string,
): DeclaredRuntimeSchemaFacet {
  const type = checker.getTypeAtLocation(expression);
  const protocolMarker = type.getProperty(SCHEMA_PROTOCOL_MARKER);
  const parse = type.getProperty("parse");
  const hasCallableTopLevelParse = parse !== undefined
    && propertyType(checker, parse, expression).getCallSignatures().length > 0;
  return protocolMarker !== undefined || hasCallableTopLevelParse
    ? schemaFacetFromType(checker, type, expression, path)
    : extractSchemaFieldsFacet(checker, expression, path);
}

function operationFailure(checker: ts.TypeChecker, type: ts.Type, path: string): TypeContractDiagnostic {
  try {
    if (isOpaque(type)) fail("opaque", path, checker, type);
    fail("metadata", path, checker, type);
  } catch (error) {
    if (error instanceof SchemaContractFailure) return error.diagnostic;
    throw error;
  }
}

/** Lower a finite adapter operation map while retaining per-schema failures. */
export function extractAdapterOperationsFacet(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  path: string,
): AdapterOperationsFacet {
  const type = checker.getTypeAtLocation(expression);
  if (
    isOpaque(type)
    || (type.flags & ts.TypeFlags.Object) === 0
    || checker.isArrayType(type)
    || checker.isTupleType(type)
    || hasIndexSignature(checker, type)
  ) {
    return { status: "unresolved", diagnostic: operationFailure(checker, type, path) };
  }

  let properties: readonly ts.Symbol[];
  try {
    properties = concreteObjectProperties(checker, type, expression, path, "metadata", true, false);
  } catch (error) {
    if (error instanceof SchemaContractFailure) return { status: "unresolved", diagnostic: error.diagnostic };
    throw error;
  }

  const operations: Record<string, AdapterOperationFacet> = {};
  for (const property of properties) {
    const operationPath = propertyPath(path, property.name);
    const operationType = propertyType(checker, property, expression);
    if ((property.flags & ts.SymbolFlags.Optional) !== 0 || isOpaque(operationType) || (operationType.flags & ts.TypeFlags.Object) === 0) {
      const diagnostic = operationFailure(checker, operationType, operationPath);
      setOwn(operations, property.name, { input: unresolved(diagnostic), output: unresolved(diagnostic) });
      continue;
    }
    const missingFacet = (["input", "output"] as const).find((name) => {
      const schemaProperty = operationType.getProperty(name);
      return schemaProperty === undefined || (schemaProperty.flags & ts.SymbolFlags.Optional) !== 0;
    });
    if (missingFacet !== undefined) {
      return {
        status: "unresolved",
        diagnostic: operationFailure(checker, operationType, propertyPath(operationPath, missingFacet)),
      };
    }
    const facet = (name: "input" | "output"): AdapterOperationFacet[typeof name] => {
      const schemaProperty = operationType.getProperty(name)!;
      return schemaFacetFromType(
        checker,
        propertyType(checker, schemaProperty, expression),
        expression,
        propertyPath(operationPath, name),
      );
    };
    setOwn(operations, property.name, { input: facet("input"), output: facet("output") });
  }
  return { status: "resolved", operations };
}

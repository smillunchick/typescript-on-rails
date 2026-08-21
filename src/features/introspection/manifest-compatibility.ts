import { decodeSemanticId, type ArchitectureManifest, type SemanticIdCategory } from "../architecture/index.js";
import { CANONICAL_SCHEMA_VERSION, SCHEMA_PROTOCOL_VERSION } from "../runtime/index.js";

export type ManifestCompatibilityErrorCode =
  | "persisted-v1"
  | "mixed-version"
  | "malformed-v2"
  | "null-semantic-id"
  | "duplicate-semantic-id";

const REGENERATE = "Regenerate the architecture manifest from source with the current analyzer.";

export class ManifestCompatibilityError extends Error {
  readonly name = "ManifestCompatibilityError";

  constructor(
    readonly code: ManifestCompatibilityErrorCode,
    message: string,
  ) {
    super(`${message} ${REGENERATE}`);
  }
}

type RecordValue = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function malformed(path: string, expected: string): never {
  throw new ManifestCompatibilityError("malformed-v2", `Invalid manifest v2: ${path} must be ${expected}.`);
}

function objectAt(value: unknown, path: string): RecordValue {
  if (!isRecord(value)) malformed(path, "an object");
  return value;
}

function arrayAt(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) malformed(path, "an array");
  return value;
}

function stringAt(value: unknown, path: string): string {
  if (typeof value !== "string") malformed(path, "a string");
  return value;
}

function lineAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) malformed(path, "a positive integer");
  return value;
}

function sourceLocationAt(value: RecordValue, path: string): void {
  stringAt(value.file, `${path}.file`);
  lineAt(value.line, `${path}.line`);
}

function serializableAt(value: unknown, path: string, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) malformed(path, "a finite number");
    return;
  }
  if (typeof value !== "object") malformed(path, "JSON-compatible data");
  if (ancestors.has(value)) malformed(path, "acyclic JSON-compatible data");
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) serializableAt(entry, `${path}[${String(index)}]`, ancestors);
  } else {
    for (const [key, entry] of Object.entries(value)) serializableAt(entry, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function diagnosticAt(value: unknown, path: string): void {
  const record = objectAt(value, path);
  stringAt(record.code, `${path}.code`);
  stringAt(record.path, `${path}.path`);
  stringAt(record.message, `${path}.message`);
}

function architectureDiagnosticAt(value: unknown, path: string): void {
  const record = objectAt(value, path);
  sourceLocationAt(record, path);
  stringAt(record.code, `${path}.code`);
  stringAt(record.rule, `${path}.rule`);
  stringAt(record.message, `${path}.message`);
  if (record.severity !== "error" && record.severity !== "warning") malformed(`${path}.severity`, '"error" or "warning"');
}

function runtimeSchemaAt(value: unknown, path: string): void {
  const facet = objectAt(value, path);
  const status = stringAt(facet.status, `${path}.status`);
  const validator = stringAt(facet.validator, `${path}.validator`);
  if (status === "resolved" && validator === "declared") {
    if (facet.provenance !== "declared-schema") malformed(`${path}.provenance`, '"declared-schema"');
    objectAt(facet.metadata, `${path}.metadata`);
    return;
  }
  if (status === "unresolved" && (validator === "declared" || validator === "not-declared")) {
    if (validator === "declared" && facet.provenance !== "declared-schema") malformed(`${path}.provenance`, '"declared-schema"');
    diagnosticAt(facet.diagnostic, `${path}.diagnostic`);
    return;
  }
  if (status === "not-declared" && validator === "not-declared") return;
  malformed(path, "a supported runtime-schema facet");
}

function staticTypeAt(value: unknown, path: string): void {
  const facet = objectAt(value, path);
  if (facet.provenance !== "inferred-typescript") malformed(`${path}.provenance`, '"inferred-typescript"');
  if (facet.status === "resolved") {
    objectAt(facet.contract, `${path}.contract`);
    return;
  }
  if (facet.status === "unresolved") {
    diagnosticAt(facet.diagnostic, `${path}.diagnostic`);
    return;
  }
  malformed(`${path}.status`, '"resolved" or "unresolved"');
}

function slotAt(value: unknown, path: string): void {
  const slot = objectAt(value, path);
  staticTypeAt(slot.staticType, `${path}.staticType`);
  runtimeSchemaAt(slot.runtimeSchema, `${path}.runtimeSchema`);
}

interface AddressableRecord {
  readonly id: string | null;
  readonly record: RecordValue;
  readonly path: string;
  readonly category: SemanticIdCategory;
  readonly ownerKind: "feature" | "infra" | "app";
  readonly ownerName: string;
  readonly name: string;
  readonly feature: string | null;
}

function addressableAt(
  value: unknown,
  path: string,
  category: SemanticIdCategory,
  requireSemanticIds: boolean,
): AddressableRecord {
  const record = objectAt(value, path);
  sourceLocationAt(record, path);
  const owner = objectAt(record.owner, `${path}.owner`);
  const ownerKind = stringAt(owner.kind, `${path}.owner.kind`);
  const ownerName = stringAt(owner.name, `${path}.owner.name`);
  const name = stringAt(record.name, `${path}.name`);
  if (ownerKind !== "feature" && ownerKind !== "infra" && ownerKind !== "app") malformed(`${path}.owner.kind`, '"feature", "infra", or "app"');
  const feature = record.feature === null ? null : stringAt(record.feature, `${path}.feature`);
  const expectedFeature = ownerKind === "feature" ? ownerName : null;
  if (feature !== expectedFeature) malformed(`${path}.feature`, "the semantic owner feature name, or null for app/infra ownership");

  if (record.id === null) {
    if (requireSemanticIds) {
      throw new ManifestCompatibilityError("null-semantic-id", `Invalid manifest v2: ${path}.id is null; semantic comparison requires a canonical ID.`);
    }
    return { id: null, record, path, category, ownerKind, ownerName, name, feature };
  }

  const id = stringAt(record.id, `${path}.id`);
  let decoded;
  try {
    decoded = decodeSemanticId(id);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ManifestCompatibilityError("malformed-v2", `Invalid manifest v2: ${path}.id is not canonical (${detail}).`);
  }
  if (decoded.category !== category) malformed(`${path}.id`, `a canonical ${category} semantic ID`);
  if (decoded.owner.kind !== ownerKind || decoded.owner.name !== ownerName || decoded.localName !== name) {
    malformed(`${path}.id`, "a canonical ID matching the record owner and name");
  }
  return { id, record, path, category, ownerKind, ownerName, name, feature };
}

function capabilityAt(value: unknown, path: string): "pure" | "ui" | "external-system" | "host-io" {
  if (value !== "pure" && value !== "ui" && value !== "external-system" && value !== "host-io") {
    malformed(path, "a supported package capability");
  }
  return value;
}

function collectAddressable(manifest: RecordValue, requireSemanticIds: boolean): AddressableRecord[] {
  const records: AddressableRecord[] = [];
  for (const [index, rawFeature] of arrayAt(manifest.features, "features").entries()) {
    const feature = addressableAt(rawFeature, `features[${String(index)}]`, "feature", requireSemanticIds);
    if (feature.ownerKind !== "feature" || feature.ownerName !== feature.name || feature.feature !== feature.name) {
      malformed(feature.path, "a feature record owned by its own feature name");
    }
    if (feature.record.publicBoundary !== null) stringAt(feature.record.publicBoundary, `${feature.path}.publicBoundary`);
    records.push(feature);
    for (const [exportIndex, entry] of arrayAt(feature.record.exports, `${feature.path}.exports`).entries()) {
      const item = addressableAt(entry, `${feature.path}.exports[${String(exportIndex)}]`, "public-export", requireSemanticIds);
      if (item.ownerKind !== "feature" || item.ownerName !== feature.name || item.feature !== feature.name) {
        malformed(item.path, `a public export owned by feature ${JSON.stringify(feature.name)}`);
      }
      stringAt(item.record.kind, `${item.path}.kind`);
      records.push(item);
    }
  }
  const categories = [
    ["models", "model"],
    ["operations", "operation"],
    ["routes", "route"],
    ["events", "event"],
  ] as const;
  for (const [property, category] of categories) {
    for (const [index, entry] of arrayAt(manifest[property], property).entries()) {
      records.push(addressableAt(entry, `${property}[${String(index)}]`, category, requireSemanticIds));
    }
  }
  for (const [index, entry] of arrayAt(manifest.adapters, "adapters").entries()) {
    const record = objectAt(entry, `adapters[${String(index)}]`);
    const category = record.kind === "contract" ? "adapter-contract" : record.kind === "implementation" ? "adapter-implementation" : null;
    if (category === null) malformed(`adapters[${String(index)}].kind`, '"contract" or "implementation"');
    records.push(addressableAt(record, `adapters[${String(index)}]`, category, requireSemanticIds));
  }
  return records;
}

function validateSemanticStructures(records: readonly AddressableRecord[]): void {
  for (const { record, path, category } of records) {
    if (category === "model") runtimeSchemaAt(record.fields, `${path}.fields`);
    if (category === "operation" || category === "route") {
      slotAt(record.input, `${path}.input`);
      slotAt(record.output, `${path}.output`);
      if (record.access !== "public" && record.access !== "permission" && record.access !== "authorize" && record.access !== "missing") {
        malformed(`${path}.access`, '"public", "permission", "authorize", or "missing"');
      }
      if (record.permission !== undefined) stringAt(record.permission, `${path}.permission`);
      if (category === "operation" && record.kind !== "action" && record.kind !== "query") {
        malformed(`${path}.kind`, '"action" or "query"');
      }
      if (category === "route") {
        if (record.method !== null) stringAt(record.method, `${path}.method`);
        if (record.path !== null) stringAt(record.path, `${path}.path`);
      }
    }
    if (category === "event") runtimeSchemaAt(record.payload, `${path}.payload`);
    if (category === "adapter-contract") {
      const operations = objectAt(record.operations, `${path}.operations`);
      if (operations.status === "unresolved") diagnosticAt(operations.diagnostic, `${path}.operations.diagnostic`);
      else if (operations.status === "resolved") {
        for (const [name, value] of Object.entries(objectAt(operations.operations, `${path}.operations.operations`))) {
          const operation = objectAt(value, `${path}.operations.operations.${name}`);
          runtimeSchemaAt(operation.input, `${path}.operations.operations.${name}.input`);
          runtimeSchemaAt(operation.output, `${path}.operations.operations.${name}.output`);
        }
      } else malformed(`${path}.operations.status`, '"resolved" or "unresolved"');
    }
    if (category === "adapter-implementation" && record.contractId !== null) {
      const contractId = stringAt(record.contractId, `${path}.contractId`);
      let decoded;
      try {
        decoded = decodeSemanticId(contractId);
      } catch {
        malformed(`${path}.contractId`, "a canonical adapter-contract semantic ID or null");
      }
      if (decoded.category !== "adapter-contract") malformed(`${path}.contractId`, "an adapter-contract semantic ID or null");
    }
  }
}

function validateManifestV2(value: unknown, requireSemanticIds: boolean): void {
  if (!isRecord(value)) malformed("manifest", "an object");
  const rootVersion = value.version;
  const compilerVersion = isRecord(value.compiler) ? value.compiler.manifestVersion : undefined;
  if (rootVersion === 1 && compilerVersion !== 2) {
    throw new ManifestCompatibilityError("persisted-v1", "Architecture manifest v1 cannot be consumed by a manifest v2 semantic consumer.");
  }
  if ((rootVersion === 2 && compilerVersion !== undefined && compilerVersion !== 2) || (rootVersion !== 2 && compilerVersion === 2)) {
    throw new ManifestCompatibilityError("mixed-version", "Architecture manifest version markers are mixed.");
  }
  if (rootVersion !== 2) malformed("version", "2");
  const compiler = objectAt(value.compiler, "compiler");
  if (compiler.manifestVersion !== 2 || compiler.typescriptVersion !== "5.9.3" || compiler.schemaProtocolVersion !== SCHEMA_PROTOCOL_VERSION || compiler.canonicalSchemaVersion !== CANONICAL_SCHEMA_VERSION || compiler.typeContractVersion !== 1) {
    malformed("compiler", "the supported manifest v2 compiler metadata");
  }
  serializableAt(value, "manifest");

  for (const property of ["packagePolicy", "packageUses", "permissions", "dependencies", "exceptions", "diagnostics"] as const) {
    arrayAt(value[property], property);
  }
  const policyPackages = new Set<string>();
  for (const [index, entry] of arrayAt(value.packagePolicy, "packagePolicy").entries()) {
    const path = `packagePolicy[${String(index)}]`;
    const policy = objectAt(entry, path);
    const packageName = stringAt(policy.package, `${path}.package`);
    if (policyPackages.has(packageName)) malformed(`${path}.package`, "a unique effective package-policy key");
    policyPackages.add(packageName);
    capabilityAt(policy.capability, `${path}.capability`);
  }
  const useCapabilities = new Map<string, string>();
  for (const [index, entry] of arrayAt(value.packageUses, "packageUses").entries()) {
    const path = `packageUses[${String(index)}]`;
    const use = objectAt(entry, path);
    sourceLocationAt(use, path);
    const packageName = stringAt(use.package, `${path}.package`);
    const capability = capabilityAt(use.capability, `${path}.capability`);
    const prior = useCapabilities.get(packageName);
    if (prior !== undefined && prior !== capability) malformed(path, "one effective capability per exact package use");
    useCapabilities.set(packageName, capability);
  }
  for (const [index, entry] of arrayAt(value.permissions, "permissions").entries()) stringAt(entry, `permissions[${String(index)}]`);
  for (const [index, entry] of arrayAt(value.dependencies, "dependencies").entries()) {
    const path = `dependencies[${String(index)}]`;
    const dependency = objectAt(entry, path);
    sourceLocationAt(dependency, path);
    stringAt(dependency.from, `${path}.from`);
    stringAt(dependency.to, `${path}.to`);
    for (const [symbolIndex, symbol] of arrayAt(dependency.symbols, `${path}.symbols`).entries()) {
      stringAt(symbol, `${path}.symbols[${String(symbolIndex)}]`);
    }
  }
  for (const [index, entry] of arrayAt(value.exceptions, "exceptions").entries()) {
    const path = `exceptions[${String(index)}]`;
    const exception = objectAt(entry, path);
    sourceLocationAt(exception, path);
    if (exception.rule !== null) stringAt(exception.rule, `${path}.rule`);
    if (exception.reason !== null) stringAt(exception.reason, `${path}.reason`);
    if (typeof exception.valid !== "boolean") malformed(`${path}.valid`, "a boolean");
  }
  for (const [index, entry] of arrayAt(value.diagnostics, "diagnostics").entries()) {
    architectureDiagnosticAt(entry, `diagnostics[${String(index)}]`);
  }

  const addressable = collectAddressable(value, requireSemanticIds);
  const featureNames = new Set(addressable
    .filter((entry) => entry.category === "feature")
    .map((entry) => entry.name));
  for (const entry of addressable) {
    if (entry.ownerKind === "feature" && !featureNames.has(entry.ownerName)) {
      malformed(entry.path, `a record owned by declared feature ${JSON.stringify(entry.ownerName)}`);
    }
  }
  const adapterContractIds = new Set(addressable
    .filter((entry) => entry.category === "adapter-contract" && entry.id !== null)
    .map((entry) => entry.id));
  for (const entry of addressable) {
    if (
      entry.category === "adapter-implementation"
      && typeof entry.record.contractId === "string"
      && !adapterContractIds.has(entry.record.contractId)
    ) {
      malformed(`${entry.path}.contractId`, "the ID of an adapter contract in the same manifest, or null");
    }
  }
  for (const [index, entry] of arrayAt(value.dependencies, "dependencies").entries()) {
    const dependency = objectAt(entry, `dependencies[${String(index)}]`);
    const from = stringAt(dependency.from, `dependencies[${String(index)}].from`);
    const to = stringAt(dependency.to, `dependencies[${String(index)}].to`);
    if (!featureNames.has(from) || !featureNames.has(to)) {
      malformed(`dependencies[${String(index)}]`, "an edge between declared feature names");
    }
  }
  if (requireSemanticIds) {
    const identities = addressable
      .flatMap(({ id, path }) => id === null ? [] : [{ id, path }])
      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.path < right.path ? -1 : 1);
    for (let index = 1; index < identities.length; index += 1) {
      const previous = identities[index - 1];
      const current = identities[index];
      if (previous !== undefined && current !== undefined && previous.id === current.id) {
        throw new ManifestCompatibilityError("duplicate-semantic-id", `Invalid manifest v2: duplicate semantic ID ${current.id} at ${previous.path} and ${current.path}.`);
      }
    }
  }
  validateSemanticStructures(addressable);
}

/** Validates the manifest-v2 runtime shape while retaining unresolved identity evidence. */
export function assertManifestV2(value: unknown): asserts value is ArchitectureManifest {
  validateManifestV2(value, false);
}

/** Validates manifest v2 for consumers that key every addressable record by semantic ID. */
export function assertComparableManifestV2(value: unknown): asserts value is ArchitectureManifest {
  validateManifestV2(value, true);
}

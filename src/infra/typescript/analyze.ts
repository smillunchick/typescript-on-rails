import path from "node:path";
import ts from "typescript";

import { encodeSemanticId } from "../../features/architecture/semantic-id.js";
import {
  architecture,
  CANONICAL_SCHEMA_VERSION,
  SCHEMA_PROTOCOL_VERSION,
} from "../../features/runtime/index.js";
import {
  runtimePackageIdentity,
  selectPackagePolicy,
  type PackagePolicyEntry,
} from "../project/package-policy.js";
import {
  extractAdapterOperationsFacet,
  extractRuntimeSchemaFacet,
  extractSchemaFieldsFacet,
  extractSchemaOrFieldsFacet,
} from "./schema-contract.js";
import {
  extractCallbackTypeContracts,
  TYPE_CONTRACT_VERSION,
  type CallbackTypeContracts,
  type TypeContractFacet,
} from "./type-contract.js";
import {
  resolveSourceRole,
  type SourceRole,
  type SourceRoleResolution,
} from "./source-role.js";
import type {
  AdapterManifest,
  AnalyzeApplicationOptions,
  ArchitectureDiagnostic,
  ArchitectureExceptionManifest,
  ArchitectureManifest,
  ContractSlot,
  DependencyManifest,
  EventManifest,
  FeatureManifest,
  ModelManifest,
  OperationManifest,
  PackagePolicyManifest,
  PackageUseManifest,
  PublicExportManifest,
  RouteManifest,
  SemanticIdOwner,
  SourceLocation,
  StaticTypeFacet,
  TypeContractDiagnostic,
} from "../../features/architecture/index.js";

architecture.allow({
  rule: "boring-typescript",
  reason: "The TypeScript compiler API exposes generic type references without a public runtime type guard.",
});

const FRAMEWORK_PACKAGE = "typescript-on-rails";

const RULE_CODES: Readonly<Record<string, string>> = {
  "architecture-allowance": "ARCH001",
  "public-boundary": "ARCH002",
  "feature-boundary": "ARCH003",
  "feature-cycle": "ARCH004",
  "runtime-boundary": "ARCH005",
  "domain-ui": "ARCH006",
  "package-capability": "ARCH007",
  "vendor-type-leak": "ARCH008",
  "boring-typescript": "ARCH009",
  "public-api-type": "ARCH010",
  "data-owner": "ARCH011",
  typescript: "ARCH012",
  "duplicate-semantic-id": "ARCH013",
  "semantic-identity": "ARCH014",
  "adapter-link": "ARCH015",
  "contract-extraction": "ARCH016",
  "package-policy": "ARCH017",
  "source-role": "ARCH018",
  "dynamic-import": "ARCH019",
};

interface PendingAdapterLink {
  readonly record: AdapterManifest & { readonly kind: "implementation" };
  readonly expression: ts.Expression | undefined;
}

interface MutableManifest {
  readonly models: ModelManifest[];
  readonly operations: OperationManifest[];
  readonly routes: RouteManifest[];
  readonly events: EventManifest[];
  readonly adapters: AdapterManifest[];
  readonly permissions: Set<string>;
  readonly dependencies: DependencyManifest[];
  readonly exceptions: ArchitectureExceptionManifest[];
  readonly diagnostics: ArchitectureDiagnostic[];
  readonly adapterContracts: Map<ts.Symbol, string>;
  readonly pendingAdapterLinks: PendingAdapterLink[];
  readonly packagePolicy: PackagePolicyManifest[];
  readonly packageUses: PackageUseManifest[];
  readonly unknownPackages: Map<string, SourceLocation[]>;
}

export interface AnalyzedCallbackTypeContract extends CallbackTypeContracts {
  readonly name: string;
  readonly kind: "operation" | "route";
  readonly file: string;
  readonly line: number;
}

export interface TypeContractAnalysis {
  readonly manifest: ArchitectureManifest;
  readonly callbacks: readonly AnalyzedCallbackTypeContract[];
}

interface FeatureRecord {
  readonly name: string;
  readonly directory: string;
  readonly files: ts.SourceFile[];
  readonly boundary?: ts.SourceFile;
}

interface FrameworkBindings {
  readonly named: ReadonlyMap<string, string>;
  readonly namespaces: ReadonlySet<string>;
}

type StaticModuleReference = ts.ImportDeclaration | ts.ExportDeclaration;
type ModuleReference = StaticModuleReference | ts.CallExpression;

interface ModuleReferenceRecord {
  readonly node: ModuleReference;
  readonly specifier?: string;
  readonly specifierNode: ts.Node;
  readonly typeOnly: boolean;
  readonly dynamic: boolean;
  readonly resolved?: string;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function slash(value: string): string {
  return value.split(path.sep).join("/");
}

function relativeFile(root: string, fileName: string): string {
  return slash(path.relative(root, fileName));
}

function location(root: string, sourceFile: ts.SourceFile, node: ts.Node): SourceLocation {
  return {
    file: relativeFile(root, sourceFile.fileName),
    line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
  };
}

function diagnostic(
  rule: string,
  message: string,
  file: string,
  line: number,
  options: {
    readonly severity?: "error" | "warning";
    readonly suggestion?: string;
    readonly target?: string;
    readonly related?: readonly SourceLocation[];
    readonly packageCapabilityMigration?: ArchitectureDiagnostic["packageCapabilityMigration"];
  } = {},
): ArchitectureDiagnostic {
  return {
    code: RULE_CODES[rule] ?? "ARCH999",
    rule,
    severity: options.severity ?? "error",
    message,
    file,
    line,
    ...(options.suggestion === undefined ? {} : { suggestion: options.suggestion }),
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.related === undefined ? {} : { related: options.related }),
    ...(options.packageCapabilityMigration === undefined
      ? {}
      : { packageCapabilityMigration: options.packageCapabilityMigration }),
  };
}

function featureNameFor(root: string, fileName: string): string | null {
  const relative = slash(path.relative(path.join(root, "src", "features"), fileName));
  if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) return null;
  return relative.split("/")[0] || null;
}

function ownerFor(root: string, fileName: string): SemanticIdOwner {
  const feature = featureNameFor(root, fileName);
  if (feature !== null) return { kind: "feature", name: feature };
  return inside(path.join(root, "src", "infra"), fileName)
    ? { kind: "infra", name: "_" }
    : { kind: "app", name: "_" };
}

function semanticId(
  category: Parameters<typeof encodeSemanticId>[0]["category"],
  owner: SemanticIdOwner,
  localName: string,
): string | null {
  try {
    return encodeSemanticId({ category, owner, localName });
  } catch {
    return null;
  }
}

function inside(root: string, fileName: string): boolean {
  const relative = path.relative(root, fileName);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isApplicationSource(root: string, sourceFile: ts.SourceFile): boolean {
  return inside(path.join(root, "src"), sourceFile.fileName) && !sourceFile.isDeclarationFile;
}

function loadProgram(root: string, options: AnalyzeApplicationOptions): {
  readonly program: ts.Program;
  readonly configDiagnostics: readonly ts.Diagnostic[];
  readonly compilerOptions: ts.CompilerOptions;
} {
  const explicitConfig = options.tsconfig === undefined ? undefined : path.resolve(root, options.tsconfig);
  const configPath = explicitConfig ?? ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
  if (configPath !== undefined) {
    const read = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      read.config,
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath,
    );
    return {
      program: ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options }),
      configDiagnostics: [...(read.error === undefined ? [] : [read.error]), ...parsed.errors],
      compilerOptions: parsed.options,
    };
  }

  const compilerOptions: ts.CompilerOptions = {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
  };
  const rootNames = ts.sys.readDirectory(path.join(root, "src"), [".ts", ".tsx"]);
  return {
    program: ts.createProgram({ rootNames, options: compilerOptions }),
    configDiagnostics: [],
    compilerOptions,
  };
}

function flattenTsDiagnostic(root: string, entry: ts.Diagnostic): ArchitectureDiagnostic {
  const message = ts.flattenDiagnosticMessageText(entry.messageText, " ");
  if (entry.file === undefined || entry.start === undefined) {
    return diagnostic("typescript", message, "tsconfig.json", 1);
  }
  const point = entry.file.getLineAndCharacterOfPosition(entry.start);
  return diagnostic("typescript", message, relativeFile(root, entry.file.fileName), point.line + 1);
}

function discoverFeatures(root: string, files: readonly ts.SourceFile[]): FeatureRecord[] {
  const records = new Map<string, { directory: string; files: ts.SourceFile[]; boundary?: ts.SourceFile }>();
  for (const sourceFile of files) {
    const name = featureNameFor(root, sourceFile.fileName);
    if (name === null) continue;
    const current = records.get(name) ?? {
      directory: path.join(root, "src", "features", name),
      files: [],
    };
    current.files.push(sourceFile);
    if (path.basename(sourceFile.fileName) === "index.ts") current.boundary = sourceFile;
    records.set(name, current);
  }
  return [...records].map(([name, value]) => ({ name, ...value })).sort((a, b) => compareText(a.name, b.name));
}

function isFrameworkImport(sourceFile: ts.SourceFile, specifier: string): boolean {
  if (specifier === FRAMEWORK_PACKAGE || specifier.startsWith(`${FRAMEWORK_PACKAGE}/`)) return true;
  if (specifier !== "./architecture.js" && specifier !== "../../features/runtime/index.js") return false;
  const source = slash(sourceFile.fileName);
  if (specifier === "./architecture.js") return source.includes("/src/features/runtime/");
  return source.includes("/src/infra/typescript/");
}

function frameworkBindings(sourceFile: ts.SourceFile): FrameworkBindings {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (!isFrameworkImport(sourceFile, statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    else {
      for (const element of bindings.elements) {
        named.set(element.name.text, element.propertyName?.text ?? element.name.text);
      }
    }
  }
  return { named, namespaces };
}

function primitiveForCall(call: ts.CallExpression, bindings: FrameworkBindings): string | null {
  if (ts.isIdentifier(call.expression)) return bindings.named.get(call.expression.text) ?? null;
  if (
    ts.isPropertyAccessExpression(call.expression)
    && ts.isIdentifier(call.expression.expression)
    && bindings.namespaces.has(call.expression.expression.text)
  ) {
    return call.expression.name.text;
  }
  return null;
}

function unwrapTransparentExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
  ) current = current.expression;
  return current;
}

function memberName(member: ts.ObjectLiteralElementLike): string | undefined {
  const name = member.name;
  return name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : undefined;
}

function objectMember(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find((member) => memberName(member) === name);
}

function memberExpression(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  const member = objectMember(object, name);
  if (member !== undefined && ts.isPropertyAssignment(member)) return member.initializer;
  if (member !== undefined && ts.isShorthandPropertyAssignment(member)) return member.name;
  return undefined;
}

function stringMember(checker: ts.TypeChecker, object: ts.ObjectLiteralExpression, name: string): string | null {
  const value = memberExpression(object, name);
  if (value === undefined) return null;
  const type = checker.getTypeAtLocation(value);
  return type.isStringLiteral() ? type.value : null;
}

function declaredName(definition: ts.ObjectLiteralExpression, fallback: string | null): string | null {
  const member = objectMember(definition, "name");
  if (member === undefined || !ts.isPropertyAssignment(member)) return fallback;
  const value = unwrapTransparentExpression(member.initializer);
  return ts.isStringLiteralLike(value) ? value.text : fallback;
}

function directObjectArgument(call: ts.CallExpression): ts.ObjectLiteralExpression | null {
  const first = call.arguments[0];
  if (first === undefined) return null;
  const value = unwrapTransparentExpression(first);
  return ts.isObjectLiteralExpression(value) ? value : null;
}

function unwrapConstSafeExpression(expression: ts.Expression): ts.Expression | null {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    if (
      (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current))
      && !ts.isConstTypeReference(current.type)
    ) return null;
    current = current.expression;
  }
  return current;
}

function constAssertedObjectOrigin(expression: ts.Expression): ts.ObjectLiteralExpression | null {
  let current = expression;
  let hasConstAssertion = false;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
      if (!ts.isConstTypeReference(current.type)) return null;
      hasConstAssertion = true;
    }
    current = current.expression;
  }
  return hasConstAssertion && ts.isObjectLiteralExpression(current) ? current : null;
}

function resolvedConstObjectExpression(
  checker: ts.TypeChecker,
  expression: ts.Expression,
  visited: Set<ts.Symbol>,
): ts.ObjectLiteralExpression | null {
  const origin = constAssertedObjectOrigin(expression);
  if (origin !== null) return origin;

  const current = unwrapConstSafeExpression(expression);
  if (current === null || (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current))) return null;
  const referenced = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(current) ? current.name : current);
  if (referenced === undefined) return null;
  const symbol = resolvedSymbol(checker, referenced);
  if (visited.has(symbol)) return null;
  visited.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (
    declaration === undefined
    || !ts.isVariableDeclaration(declaration)
    || declaration.initializer === undefined
    || (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) return null;
  return resolvedConstObjectExpression(checker, declaration.initializer, visited);
}

function resolvedObjectArgument(checker: ts.TypeChecker, call: ts.CallExpression): ts.ObjectLiteralExpression | null {
  const first = call.arguments[0];
  if (first === undefined) return null;
  return directObjectArgument(call) ?? resolvedConstObjectExpression(checker, first, new Set());
}

function variableDeclaration(node: ts.Node): ts.VariableDeclaration | null {
  let current = node;
  while (
    ts.isParenthesizedExpression(current.parent)
    || ts.isAsExpression(current.parent)
    || ts.isTypeAssertionExpression(current.parent)
    || ts.isSatisfiesExpression(current.parent)
  ) current = current.parent;
  const declaration = current.parent;
  return ts.isVariableDeclaration(declaration) && declaration.initializer === current ? declaration : null;
}

function variableName(node: ts.Node): string | null {
  const declaration = variableDeclaration(node);
  return declaration !== null && ts.isIdentifier(declaration.name) ? declaration.name.text : null;
}

function staticFacet(facet: TypeContractFacet): StaticTypeFacet {
  return { ...facet, provenance: "inferred-typescript" };
}

function contractSlot(staticType: TypeContractFacet, runtimeSchema: ContractSlot["runtimeSchema"]): ContractSlot {
  return { staticType: staticFacet(staticType), runtimeSchema };
}

function missingRequiredSchemaFacet(path: string): ContractSlot["runtimeSchema"] {
  return {
    status: "unresolved",
    validator: "not-declared",
    diagnostic: { code: "SC004", path, message: "The required runtime schema was not declared" },
  };
}

function accessFor(definition: ts.ObjectLiteralExpression): "public" | "permission" | "authorize" | "missing" {
  if (objectMember(definition, "permission") !== undefined) return "permission";
  if (objectMember(definition, "authorize") !== undefined) return "authorize";
  if (objectMember(definition, "public") !== undefined) return "public";
  return "missing";
}

function unresolvedCallbackContracts(): CallbackTypeContracts {
  const facet = (path: "input" | "output"): TypeContractFacet => ({
    status: "unresolved",
    labels: [],
    diagnostic: { code: "TC009", path, message: "The callback must have one resolvable call signature" },
  });
  return { input: facet("input"), output: facet("output") };
}

function extractDeclarations(
  root: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  output: MutableManifest,
  callbacks: AnalyzedCallbackTypeContract[],
): void {
  const bindings = frameworkBindings(sourceFile);
  const feature = featureNameFor(root, sourceFile.fileName);
  const owner = ownerFor(root, sourceFile.fileName);

  const identity = (
    category: Parameters<typeof semanticId>[0],
    name: string,
    node: ts.Node,
  ) => ({
    id: semanticId(category, owner, name),
    owner,
    name,
    feature,
    ...location(root, sourceFile, node),
  });

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const primitive = primitiveForCall(node, bindings);
      const nameFromVariable = variableName(node);
      const definition = primitive === null ? null : resolvedObjectArgument(checker, node);
      if (primitive === "defineModel") {
        const name = definition === null ? (nameFromVariable ?? "") : (declaredName(definition, nameFromVariable) ?? "");
        const fieldsExpression = definition === null ? undefined : memberExpression(definition, "fields");
        output.models.push({
          ...identity("model", name, node),
          fields: fieldsExpression === undefined
            ? missingRequiredSchemaFacet("fields")
            : extractSchemaFieldsFacet(checker, fieldsExpression, "fields"),
        });
      } else if (primitive === "action" || primitive === "query") {
        const name = nameFromVariable ?? "";
        const permission = definition === null ? null : stringMember(checker, definition, "permission");
        const extracted = definition === null
          ? unresolvedCallbackContracts()
          : extractCallbackTypeContracts(checker, definition, "run");
        const inputExpression = definition === null ? undefined : memberExpression(definition, "input");
        const outputExpression = definition === null ? undefined : memberExpression(definition, "output");
        output.operations.push({
          ...identity("operation", name, node),
          kind: primitive,
          input: {
            staticType: staticFacet(extracted.input),
            runtimeSchema: inputExpression === undefined
              ? missingRequiredSchemaFacet("input")
              : extractSchemaOrFieldsFacet(checker, inputExpression, "input"),
          },
          output: contractSlot(
            extracted.output,
            extractRuntimeSchemaFacet(checker, outputExpression, "output"),
          ),
          access: definition === null ? "missing" : accessFor(definition),
          ...(permission === null ? {} : { permission }),
        });
        callbacks.push({
          name,
          kind: "operation",
          ...location(root, sourceFile, node),
          ...extracted,
        });
        if (permission !== null) output.permissions.add(permission);
      } else if (primitive === "route") {
        const name = nameFromVariable ?? "";
        const permission = definition === null ? null : stringMember(checker, definition, "permission");
        const extracted = definition === null
          ? unresolvedCallbackContracts()
          : extractCallbackTypeContracts(checker, definition, "handler");
        const inputExpression = definition === null ? undefined : memberExpression(definition, "input");
        const outputExpression = definition === null ? undefined : memberExpression(definition, "output");
        output.routes.push({
          ...identity("route", name, node),
          method: definition === null ? null : stringMember(checker, definition, "method"),
          path: definition === null ? null : stringMember(checker, definition, "path"),
          input: contractSlot(
            extracted.input,
            inputExpression === undefined
              ? extractRuntimeSchemaFacet(checker, undefined, "input")
              : extractSchemaOrFieldsFacet(checker, inputExpression, "input"),
          ),
          output: contractSlot(
            extracted.output,
            extractRuntimeSchemaFacet(checker, outputExpression, "output"),
          ),
          access: definition === null ? "missing" : accessFor(definition),
          ...(permission === null ? {} : { permission }),
        });
        callbacks.push({
          name,
          kind: "route",
          ...location(root, sourceFile, node),
          ...extracted,
        });
        if (permission !== null) output.permissions.add(permission);
      } else if (primitive === "event") {
        const name = definition === null ? (nameFromVariable ?? "") : (declaredName(definition, nameFromVariable) ?? "");
        const payloadExpression = definition === null ? undefined : memberExpression(definition, "payload");
        output.events.push({
          ...identity("event", name, node),
          payload: payloadExpression === undefined
            ? missingRequiredSchemaFacet("payload")
            : extractRuntimeSchemaFacet(checker, payloadExpression, "payload"),
        });
      } else if (primitive === "defineAdapterContract") {
        const name = definition === null ? (nameFromVariable ?? "") : (declaredName(definition, nameFromVariable) ?? "");
        const operationsExpression = definition === null ? undefined : memberExpression(definition, "operations");
        const record: AdapterManifest & { readonly kind: "contract" } = {
          ...identity("adapter-contract", name, node),
          kind: "contract",
          operations: operationsExpression === undefined
            ? { status: "unresolved", diagnostic: { code: "SC002", path: "operations", message: "The schema metadata type is invalid or unknown" } }
            : extractAdapterOperationsFacet(checker, operationsExpression, "operations"),
        };
        output.adapters.push(record);
        const declaration = variableDeclaration(node);
        if (declaration !== null && ts.isIdentifier(declaration.name) && record.id !== null) {
          const symbol = checker.getSymbolAtLocation(declaration.name);
          if (symbol !== undefined) output.adapterContracts.set(symbol, record.id);
        }
      } else if (primitive === "implementAdapter") {
        const name = nameFromVariable ?? "";
        const record: AdapterManifest & { readonly kind: "implementation" } = {
          ...identity("adapter-implementation", name, node),
          kind: "implementation",
          contractId: null,
        };
        output.adapters.push(record);
        output.pendingAdapterLinks.push({ record, expression: node.arguments[0] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function isExactUtcDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function extractAllowances(root: string, sourceFile: ts.SourceFile, output: MutableManifest): void {
  const bindings = frameworkBindings(sourceFile);
  const architectureNames = new Set(
    [...bindings.named].filter(([, imported]) => imported === "architecture").map(([local]) => local),
  );
  const today = new Date().toISOString().slice(0, 10);

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === "allow"
      && (
        (ts.isIdentifier(node.expression.expression) && architectureNames.has(node.expression.expression.text))
        || (
          ts.isPropertyAccessExpression(node.expression.expression)
          && ts.isIdentifier(node.expression.expression.expression)
          && bindings.namespaces.has(node.expression.expression.expression.text)
          && node.expression.expression.name.text === "architecture"
        )
      )
    ) {
      const definition = directObjectArgument(node);
      const directString = (name: string): string | null => {
        if (definition === null) return null;
        const value = memberExpression(definition, name);
        return value !== undefined && ts.isStringLiteralLike(value) ? value.text : null;
      };
      const rule = directString("rule");
      const reason = directString("reason");
      const expires = directString("expires");
      const target = directString("target");
      let valid = rule !== null && rule.trim() !== "" && reason !== null && reason.trim() !== "";
      let issue: string | null = null;
      if (!valid) issue = "Architecture allowances require a nonblank literal rule and reason";
      if (expires !== null) {
        const parsed = isExactUtcDate(expires);
        if (!parsed) {
          valid = false;
          issue = "Architecture allowance expiry must use a valid YYYY-MM-DD date";
        } else if (expires < today) {
          valid = false;
          issue = `Architecture allowance expired on ${expires}`;
        }
      }
      const entry: ArchitectureExceptionManifest = {
        rule,
        reason,
        ...location(root, sourceFile, node),
        ...(expires === null ? {} : { expires }),
        ...(target === null ? {} : { target }),
        valid,
      };
      output.exceptions.push(entry);
      if (issue !== null) output.diagnostics.push(diagnostic("architecture-allowance", issue, entry.file, entry.line));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function moduleReferencesFor(sourceFile: ts.SourceFile, compilerOptions: ts.CompilerOptions): ModuleReferenceRecord[] {
  const references: ModuleReferenceRecord[] = [];
  for (const statement of sourceFile.statements) {
    if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
      || statement.moduleSpecifier === undefined
      || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    let typeOnly = false;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      typeOnly = clause?.isTypeOnly === true
        || (clause?.name === undefined
          && clause?.namedBindings !== undefined
          && ts.isNamedImports(clause.namedBindings)
          && clause.namedBindings.elements.length > 0
          && clause.namedBindings.elements.every((entry) => entry.isTypeOnly));
    } else if (statement.exportClause !== undefined && ts.isNamedExports(statement.exportClause)) {
      typeOnly = statement.isTypeOnly || (statement.exportClause.elements.length > 0
        && statement.exportClause.elements.every((entry) => entry.isTypeOnly));
    } else {
      typeOnly = statement.isTypeOnly;
    }
    const resolved = ts.resolveModuleName(specifier, sourceFile.fileName, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
    references.push({
      node: statement,
      specifier,
      specifierNode: statement.moduleSpecifier,
      typeOnly,
      dynamic: false,
      ...(resolved === undefined ? {} : { resolved }),
    });
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      const specifier = argument !== undefined && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ? argument.text
        : undefined;
      const resolved = specifier === undefined
        ? undefined
        : ts.resolveModuleName(specifier, sourceFile.fileName, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
      references.push({
        node,
        ...(specifier === undefined ? {} : { specifier }),
        specifierNode: argument ?? node,
        typeOnly: false,
        dynamic: true,
        ...(resolved === undefined ? {} : { resolved }),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function referencedPublicSymbols(node: ModuleReference): string[] {
  if (ts.isCallExpression(node)) return ["*"];
  if (ts.isExportDeclaration(node)) {
    if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) return ["*"];
    return [...new Set(node.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text))]
      .sort(compareText);
  }
  const clause = node.importClause;
  if (clause === undefined) return [];
  const symbols: string[] = [];
  if (clause.name !== undefined) symbols.push("default");
  if (clause.namedBindings !== undefined) {
    if (ts.isNamespaceImport(clause.namedBindings)) symbols.push("*");
    else for (const element of clause.namedBindings.elements) symbols.push(element.propertyName?.text ?? element.name.text);
  }
  return [...new Set(symbols)].sort(compareText);
}

function packagePolicyMap(entries: readonly PackagePolicyEntry[]): ReadonlyMap<string, PackagePolicyEntry["capability"]> {
  return new Map(entries.map((entry) => [entry.package, entry.capability]));
}

function requiredCapabilityBoundary(capability: PackagePolicyEntry["capability"]): string {
  if (capability === "pure") return "all current source roles";
  if (capability === "ui") return "UI/client code only";
  return "infrastructure code only";
}

function capabilityAllowed(capability: PackagePolicyEntry["capability"], role: SourceRole): boolean {
  if (capability === "pure") return true;
  if (capability === "ui") return role === "ui/client";
  return role === "infrastructure";
}

function capabilityAllowedForEveryRole(
  capability: PackagePolicyEntry["capability"],
  roles: readonly SourceRole[],
): boolean {
  return roles.every((role) => capabilityAllowed(capability, role));
}

function isInfra(root: string, fileName: string): boolean {
  return inside(path.join(root, "src", "infra"), fileName);
}

function referencedValueDeclarationFiles(checker: ts.TypeChecker, node: ModuleReference): string[] {
  if (ts.isExportDeclaration(node) && node.isTypeOnly) return [];
  const symbols: ts.Symbol[] = [];
  const addSymbol = (name: ts.Node): void => {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol !== undefined) symbols.push(resolvedSymbol(checker, symbol));
  };
  const addModuleExports = (moduleSpecifier: ts.Node | undefined): void => {
    const moduleSymbol = moduleSpecifier === undefined ? undefined : checker.getSymbolAtLocation(moduleSpecifier);
    if (moduleSymbol !== undefined) {
      for (const exported of checker.getExportsOfModule(moduleSymbol)) symbols.push(resolvedSymbol(checker, exported));
    }
  };
  if (ts.isCallExpression(node)) {
    addModuleExports(node.arguments[0]);
  } else if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (clause === undefined || clause.isTypeOnly) return [];
    if (clause.name !== undefined) addSymbol(clause.name);
    if (clause.namedBindings !== undefined) {
      if (ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) addSymbol(element.name);
      } else {
        const namespaceSymbol = checker.getSymbolAtLocation(clause.namedBindings.name);
        if (namespaceSymbol !== undefined) {
          const moduleSymbol = resolvedSymbol(checker, namespaceSymbol);
          for (const exported of checker.getExportsOfModule(moduleSymbol)) symbols.push(resolvedSymbol(checker, exported));
        }
      }
    }
  } else if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
    for (const element of node.exportClause.elements) if (!element.isTypeOnly) addSymbol(element.name);
  } else {
    addModuleExports(node.moduleSpecifier);
  }
  return [...new Set(symbols.flatMap((symbol) => symbol.declarations ?? []).map((entry) => entry.getSourceFile().fileName))];
}

function checkImports(
  root: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  compilerOptions: ts.CompilerOptions,
  sourceRoles: ReadonlyMap<string, SourceRoleResolution>,
  policy: ReadonlyMap<string, PackagePolicyEntry["capability"]>,
  blockedPackages: ReadonlySet<string>,
  output: MutableManifest,
): void {
  const sourceFeature = featureNameFor(root, sourceFile.fileName);
  const sourceRole = sourceRoles.get(path.resolve(sourceFile.fileName)) ?? resolveSourceRole(root, sourceFile);
  const rolesText = sourceRole.effectiveRoles.join(", ");
  if (sourceRole.conflict) {
    const point = location(root, sourceFile, sourceFile);
    const signals = sourceRole.signals.map((entry) => `${entry.role} (${entry.signal})`).join(", ");
    output.diagnostics.push(diagnostic(
      "source-role",
      `Source file has conflicting explicit roles: ${signals}`,
      point.file,
      point.line,
    ));
  }

  for (const entry of moduleReferencesFor(sourceFile, compilerOptions)) {
    const importLocation = location(root, sourceFile, entry.specifierNode);
    if (entry.dynamic) {
      if (entry.specifier === undefined) {
        output.diagnostics.push(diagnostic(
          "dynamic-import",
          "Dynamic import() requires one string literal or no-substitution template literal specifier",
          importLocation.file,
          importLocation.line,
        ));
        continue;
      }
      const allowed = sourceRole.effectiveRoles.every((role) => role === "infrastructure" || role === "ui/client");
      if (!allowed) {
        output.diagnostics.push(diagnostic(
          "dynamic-import",
          `Literal dynamic import() is not allowed for source role ${rolesText}`,
          importLocation.file,
          importLocation.line,
          { target: entry.specifier },
        ));
      }
    }

    const specifier = entry.specifier;
    if (specifier === undefined) continue;
    const targetFeature = entry.resolved === undefined ? null : featureNameFor(root, entry.resolved);
    if (sourceFeature !== null && targetFeature !== null && sourceFeature !== targetFeature) {
      output.dependencies.push({
        from: sourceFeature,
        to: targetFeature,
        symbols: referencedPublicSymbols(entry.node),
        ...importLocation,
      });
      const targetBase = path.basename(entry.resolved ?? "");
      if (!/^index\.tsx?$/.test(targetBase)) {
        output.diagnostics.push(diagnostic(
          "feature-boundary",
          `${sourceFeature} cannot import a private module from ${targetFeature}`,
          importLocation.file,
          importLocation.line,
          { suggestion: `Import from @/features/${targetFeature}`, target: targetFeature },
        ));
      }
    }

    const targetRole = entry.resolved === undefined
      ? undefined
      : sourceRoles.get(path.resolve(entry.resolved));
    const packageIdentity = runtimePackageIdentity(specifier);
    const nodeModule = packageIdentity?.nodeCapability !== undefined;
    if (sourceRole.effectiveRoles.includes("ui/client") && !entry.typeOnly) {
      const runtimeTargets = [
        ...(entry.resolved === undefined ? [] : [entry.resolved]),
        ...referencedValueDeclarationFiles(checker, entry.node),
      ];
      const unsafeTarget = nodeModule || runtimeTargets.some((target) => (
        /\.server\.tsx?$/.test(target)
        || /\/(actions)(\.tsx?$|\/)/.test(slash(target))
        || /\/(db|database)(\.tsx?$|\/)/.test(slash(target))
        || isInfra(root, target)
      ));
      if (unsafeTarget) {
        output.diagnostics.push(diagnostic(
          "runtime-boundary",
          `Client code cannot import server-only module ${specifier}`,
          importLocation.file,
          importLocation.line,
          { target: specifier },
        ));
      }
    }
    if (sourceRole.effectiveRoles.includes("domain") && targetRole?.effectiveRoles.includes("ui/client") === true) {
      output.diagnostics.push(diagnostic(
        "domain-ui",
        `Domain code cannot import UI module ${specifier}`,
        importLocation.file,
        importLocation.line,
        { target: specifier },
      ));
    }

    const isInternal = entry.resolved !== undefined && inside(path.join(root, "src"), entry.resolved);
    if (entry.typeOnly || isInternal) continue;
    if (packageIdentity === null) {
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        output.diagnostics.push(diagnostic(
          "package-capability",
          `Runtime module specifier ${JSON.stringify(specifier)} cannot be mapped to an exact package capability key`,
          importLocation.file,
          importLocation.line,
          {
            suggestion: "Import the external package by its package root or exact subpath",
            target: specifier,
          },
        ));
      }
      continue;
    }
    if (packageIdentity.framework) continue;

    const blockedByPolicy = blockedPackages.has(packageIdentity.exact)
      || (policy.get(packageIdentity.exact) === undefined && blockedPackages.has(packageIdentity.root));
    if (blockedByPolicy && packageIdentity.nodeCapability === undefined) continue;

    const capability = packageIdentity.nodeCapability
      ?? policy.get(packageIdentity.exact)
      ?? policy.get(packageIdentity.root);
    if (capability === undefined) {
      const uses = output.unknownPackages.get(packageIdentity.root) ?? [];
      uses.push(importLocation);
      output.unknownPackages.set(packageIdentity.root, uses);
      continue;
    }

    output.packageUses.push({
      package: packageIdentity.exact,
      capability,
      ...importLocation,
    });
    if (!capabilityAllowedForEveryRole(capability, sourceRole.effectiveRoles)) {
      output.diagnostics.push(diagnostic(
        "package-capability",
        `Package ${packageIdentity.exact} has capability ${capability}; current role ${rolesText} requires ${requiredCapabilityBoundary(capability)}`,
        importLocation.file,
        importLocation.line,
        { target: packageIdentity.exact },
      ));
    }
  }
}

function checkBoringTypeScript(root: string, sourceFile: ts.SourceFile, output: MutableManifest): void {
  const report = (node: ts.Node, message: string): void => {
    const point = location(root, sourceFile, node);
    output.diagnostics.push(diagnostic("boring-typescript", message, point.file, point.line));
  };
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) report(node, "Explicit any is not allowed");
    else if (ts.isNonNullExpression(node)) report(node, "Non-null assertions are not allowed");
    else if (ts.isTypeAssertionExpression(node)) report(node, "Unchecked type assertions are not allowed");
    else if (ts.isAsExpression(node) && !(ts.isTypeReferenceNode(node.type) && node.type.typeName.getText() === "const")) {
      report(node, "Unchecked type assertions are not allowed");
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      report(node, "External import = require() is not allowed");
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      report(node, "Dynamic require() is not allowed");
    }
    if (ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0) {
      report(node, "Decorators are not allowed");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function symbolKind(symbol: ts.Symbol): string {
  const flags = symbol.flags;
  if ((flags & ts.SymbolFlags.Function) !== 0) return "function";
  if ((flags & ts.SymbolFlags.Class) !== 0) return "class";
  if ((flags & ts.SymbolFlags.Interface) !== 0) return "interface";
  if ((flags & ts.SymbolFlags.TypeAlias) !== 0) return "type";
  if ((flags & ts.SymbolFlags.Enum) !== 0) return "enum";
  return "value";
}

function resolvedSymbol(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function symbolType(checker: ts.TypeChecker, symbol: ts.Symbol, locationNode: ts.Node): ts.Type {
  if ((symbol.flags & (ts.SymbolFlags.TypeAlias | ts.SymbolFlags.Interface | ts.SymbolFlags.Class)) !== 0) {
    return checker.getDeclaredTypeOfSymbol(symbol);
  }
  return checker.getTypeOfSymbolAtLocation(symbol, locationNode);
}

function typeHasAny(root: string, checker: ts.TypeChecker, type: ts.Type, visited: Set<ts.Type>): boolean {
  if (visited.has(type)) return false;
  visited.add(type);
  if ((type.flags & ts.TypeFlags.Any) !== 0) return true;
  if (type.isUnionOrIntersection() && type.types.some((part) => typeHasAny(root, checker, part, visited))) return true;
  const reference = type as ts.TypeReference;
  if ((reference.typeArguments ?? []).some((argument) => typeHasAny(root, checker, argument, visited))) return true;
  const declarations = [type.getSymbol(), type.aliasSymbol]
    .filter((entry): entry is ts.Symbol => entry !== undefined)
    .flatMap((symbol) => symbol.declarations ?? []);
  if (declarations.length > 0 && declarations.every((entry) => !inside(path.join(root, "src"), entry.getSourceFile().fileName))) {
    return false;
  }
  for (const propertySymbol of checker.getPropertiesOfType(type)) {
    const declaration = propertySymbol.valueDeclaration ?? propertySymbol.declarations?.[0];
    if (declaration !== undefined && typeHasAny(root, checker, checker.getTypeOfSymbolAtLocation(propertySymbol, declaration), visited)) return true;
  }
  for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
    if (typeHasAny(root, checker, signature.getReturnType(), visited)) return true;
    for (const parameter of signature.parameters) {
      const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
      if (declaration !== undefined && typeHasAny(root, checker, checker.getTypeOfSymbolAtLocation(parameter, declaration), visited)) return true;
    }
  }
  return false;
}

function sourceIsVendor(root: string, fileName: string): boolean {
  if (isInfra(root, fileName)) return true;
  const normalized = slash(fileName);
  return normalized.includes("/node_modules/")
    && !normalized.includes(`/node_modules/${FRAMEWORK_PACKAGE}/`)
    && !normalized.includes("/node_modules/typescript/")
    && !normalized.includes("/node_modules/@types/");
}

function typeHasVendorOrigin(root: string, checker: ts.TypeChecker, type: ts.Type, visited: Set<ts.Type>): boolean {
  if (visited.has(type)) return false;
  visited.add(type);
  const symbols = [type.getSymbol(), type.aliasSymbol].filter((entry): entry is ts.Symbol => entry !== undefined);
  if (symbols.some((symbol) => symbol.declarations?.some((entry) => sourceIsVendor(root, entry.getSourceFile().fileName)) === true)) return true;
  if (type.isUnionOrIntersection() && type.types.some((part) => typeHasVendorOrigin(root, checker, part, visited))) return true;
  const reference = type as ts.TypeReference;
  if ((reference.typeArguments ?? []).some((argument) => typeHasVendorOrigin(root, checker, argument, visited))) return true;
  const declarations = symbols.flatMap((symbol) => symbol.declarations ?? []);
  if (declarations.length > 0 && declarations.every((entry) => !inside(path.join(root, "src"), entry.getSourceFile().fileName))) {
    return false;
  }
  for (const propertySymbol of checker.getPropertiesOfType(type)) {
    if (propertySymbol.declarations?.some((entry) => sourceIsVendor(root, entry.getSourceFile().fileName)) === true) return true;
    const declaration = propertySymbol.valueDeclaration ?? propertySymbol.declarations?.[0];
    if (declaration !== undefined && typeHasVendorOrigin(root, checker, checker.getTypeOfSymbolAtLocation(propertySymbol, declaration), visited)) return true;
  }
  for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
    if (typeHasVendorOrigin(root, checker, signature.getReturnType(), visited)) return true;
    for (const parameter of signature.parameters) {
      const declaration = parameter.valueDeclaration ?? parameter.declarations?.[0];
      if (declaration !== undefined && typeHasVendorOrigin(root, checker, checker.getTypeOfSymbolAtLocation(parameter, declaration), visited)) return true;
    }
  }
  return false;
}

function featureManifest(
  root: string,
  feature: FeatureRecord,
  checker: ts.TypeChecker,
  output: MutableManifest,
): FeatureManifest {
  const exports: PublicExportManifest[] = [];
  const owner: SemanticIdOwner = { kind: "feature", name: feature.name };
  const featureIdentity = {
    id: semanticId("feature", owner, feature.name),
    owner,
    name: feature.name,
    feature: feature.name,
  };
  if (feature.boundary === undefined) {
    const file = relativeFile(root, feature.directory);
    output.diagnostics.push(diagnostic(
      "public-boundary",
      `Feature ${feature.name} must define one public boundary at index.ts`,
      file,
      1,
      { suggestion: `Create src/features/${feature.name}/index.ts` },
    ));
    return { ...featureIdentity, publicBoundary: null, exports, file, line: 1 };
  }

  const moduleSymbol = checker.getSymbolAtLocation(feature.boundary);
  for (const exported of moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)) {
    const symbol = resolvedSymbol(checker, exported);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? feature.boundary;
    const entry = {
      id: semanticId("public-export", owner, exported.name),
      owner,
      name: exported.name,
      feature: feature.name,
      kind: symbolKind(symbol),
      ...location(root, declaration.getSourceFile(), declaration),
    };
    exports.push(entry);
    const type = symbolType(checker, symbol, declaration);
    if (typeHasAny(root, checker, type, new Set())) {
      output.diagnostics.push(diagnostic(
        "public-api-type",
        `Public export ${exported.name} contains any or an unresolved type`,
        entry.file,
        entry.line,
        { target: exported.name },
      ));
    }
    if (typeHasVendorOrigin(root, checker, type, new Set())) {
      output.diagnostics.push(diagnostic(
        "vendor-type-leak",
        `Public export ${exported.name} leaks an infrastructure or vendor type`,
        entry.file,
        entry.line,
        { target: exported.name },
      ));
    }
  }
  exports.sort(compareSemantic);
  const point = location(root, feature.boundary, feature.boundary);
  return { ...featureIdentity, publicBoundary: point.file, exports, ...point };
}

function addCycleDiagnostics(root: string, features: readonly FeatureRecord[], output: MutableManifest): void {
  const graph = new Map<string, Set<string>>(features.map((feature) => [feature.name, new Set()]));
  for (const edge of output.dependencies) graph.get(edge.from)?.add(edge.to);
  const completed = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles = new Set<string>();

  const visit = (name: string): void => {
    if (completed.has(name)) return;
    stack.push(name);
    onStack.add(name);
    for (const dependency of [...(graph.get(name) ?? [])].sort()) {
      if (onStack.has(dependency)) {
        const start = stack.indexOf(dependency);
        const cycle = [...stack.slice(start), dependency];
        cycles.add(cycle.join(" -> "));
      } else visit(dependency);
    }
    stack.pop();
    onStack.delete(name);
    completed.add(name);
  };
  for (const feature of features) visit(feature.name);
  for (const cycle of [...cycles].sort()) {
    const first = cycle.split(" -> ")[0] ?? "";
    const feature = features.find((entry) => entry.name === first);
    output.diagnostics.push(diagnostic(
      "feature-cycle",
      `Circular feature dependency: ${cycle}`,
      feature?.boundary === undefined
        ? relativeFile(root, feature?.directory ?? root)
        : relativeFile(root, feature.boundary.fileName),
      1,
      { target: first },
    ));
  }
}

function adapterContractSymbol(checker: ts.TypeChecker, expression: ts.Expression, visited: Set<ts.Symbol>): ts.Symbol | null {
  const current = unwrapTransparentExpression(expression);
  if (!ts.isIdentifier(current) && !ts.isPropertyAccessExpression(current)) return null;
  const symbolAtExpression = checker.getSymbolAtLocation(ts.isPropertyAccessExpression(current) ? current.name : current);
  if (symbolAtExpression === undefined) return null;
  const symbol = resolvedSymbol(checker, symbolAtExpression);
  if (visited.has(symbol)) return null;
  visited.add(symbol);
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (
    declaration !== undefined
    && ts.isVariableDeclaration(declaration)
    && declaration.initializer !== undefined
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    const alias = adapterContractSymbol(checker, declaration.initializer, visited);
    if (alias !== null) return alias;
  }
  return symbol;
}

function resolveAdapterLinks(checker: ts.TypeChecker, output: MutableManifest): void {
  for (const pending of output.pendingAdapterLinks) {
    const symbol = pending.expression === undefined
      ? null
      : adapterContractSymbol(checker, pending.expression, new Set());
    const contractId = symbol === null ? undefined : output.adapterContracts.get(symbol);
    const index = output.adapters.indexOf(pending.record);
    if (contractId !== undefined && index >= 0) {
      output.adapters[index] = { ...pending.record, contractId };
      continue;
    }
    output.diagnostics.push(diagnostic(
      "adapter-link",
      `Adapter implementation ${pending.record.name || "<unnamed>"} does not reference a declared adapter contract`,
      pending.record.file,
      pending.record.line,
      pending.record.id === null ? {} : { target: pending.record.id },
    ));
  }
}

function addIdentityDiagnostics(records: readonly { readonly id: string | null; readonly name: string; readonly file: string; readonly line: number }[], output: MutableManifest): void {
  for (const record of records) {
    if (record.id !== null) continue;
    output.diagnostics.push(diagnostic(
      "semantic-identity",
      "The recognized declaration cannot form a canonical semantic ID",
      record.file,
      record.line,
    ));
  }
}

function addContractDiagnostic(
  facet: { readonly status: string; readonly diagnostic?: TypeContractDiagnostic },
  locationPoint: SourceLocation,
  target: string | null,
  output: MutableManifest,
): void {
  if (facet.status !== "unresolved" || facet.diagnostic === undefined) return;
  const underlying = facet.diagnostic;
  output.diagnostics.push(diagnostic(
    "contract-extraction",
    `${underlying.code} at ${underlying.path}: ${underlying.message}`,
    locationPoint.file,
    locationPoint.line,
    target === null ? {} : { target },
  ));
}

function addContractDiagnostics(output: MutableManifest): void {
  for (const model of output.models) addContractDiagnostic(model.fields, model, model.id, output);
  for (const operation of output.operations) {
    addContractDiagnostic(operation.input.staticType, operation, operation.id, output);
    addContractDiagnostic(operation.input.runtimeSchema, operation, operation.id, output);
    addContractDiagnostic(operation.output.staticType, operation, operation.id, output);
    addContractDiagnostic(operation.output.runtimeSchema, operation, operation.id, output);
  }
  for (const route of output.routes) {
    addContractDiagnostic(route.input.staticType, route, route.id, output);
    addContractDiagnostic(route.input.runtimeSchema, route, route.id, output);
    addContractDiagnostic(route.output.staticType, route, route.id, output);
    addContractDiagnostic(route.output.runtimeSchema, route, route.id, output);
  }
  for (const event of output.events) addContractDiagnostic(event.payload, event, event.id, output);
  for (const adapter of output.adapters) {
    if (adapter.kind !== "contract") continue;
    addContractDiagnostic(adapter.operations, adapter, adapter.id, output);
    if (adapter.operations.status !== "resolved") continue;
    for (const operation of Object.values(adapter.operations.operations)) {
      addContractDiagnostic(operation.input, adapter, adapter.id, output);
      addContractDiagnostic(operation.output, adapter, adapter.id, output);
    }
  }
}

function addDuplicateIdDiagnostics(
  records: readonly { readonly id: string | null; readonly file: string; readonly line: number }[],
  output: MutableManifest,
): void {
  const byId = new Map<string, SourceLocation[]>();
  for (const record of records) {
    if (record.id === null) continue;
    const locations = byId.get(record.id) ?? [];
    locations.push({ file: record.file, line: record.line });
    byId.set(record.id, locations);
  }
  for (const [id, locations] of [...byId].sort(([left], [right]) => compareText(left, right))) {
    if (locations.length < 2) continue;
    locations.sort(compareLocated);
    const anchor = locations[0]!;
    output.diagnostics.push(diagnostic(
      "duplicate-semantic-id",
      `Duplicate semantic ID: ${id}`,
      anchor.file,
      anchor.line,
      { target: id, related: locations },
    ));
  }
}

function checkDuplicateOwners(output: MutableManifest): void {
  const byName = new Map<string, ModelManifest[]>();
  for (const model of output.models) {
    const models = byName.get(model.name) ?? [];
    models.push(model);
    byName.set(model.name, models);
  }
  for (const [name, models] of byName) {
    const owners = [...new Set(models.map((model) => model.feature).filter((owner): owner is string => owner !== null))];
    if (owners.length < 2) continue;
    for (const model of models) {
      output.diagnostics.push(diagnostic(
        "data-owner",
        `Model ${name} has multiple feature owners: ${owners.sort().join(", ")}`,
        model.file,
        model.line,
        { target: name },
      ));
    }
  }
}

function applyAllowances(output: MutableManifest): void {
  const valid = output.exceptions.filter((entry) => entry.valid && entry.rule !== null);
  const invalidDiagnostics = output.diagnostics.filter((entry) => entry.rule === "architecture-allowance");
  const retained = output.diagnostics.filter((entry) => {
    if (entry.rule === "architecture-allowance") return false;
    return !valid.some((allowance) => allowance.file === entry.file
      && allowance.rule === entry.rule
      && (allowance.target === undefined || allowance.target === entry.target));
  });
  output.diagnostics.splice(0, output.diagnostics.length, ...invalidDiagnostics, ...retained);
}

function compareNamed(a: { readonly name: string; readonly file: string; readonly line: number }, b: { readonly name: string; readonly file: string; readonly line: number }): number {
  return compareText(a.name, b.name) || compareText(a.file, b.file) || a.line - b.line;
}

function compareLocated(a: { readonly file: string; readonly line: number }, b: { readonly file: string; readonly line: number }): number {
  return compareText(a.file, b.file) || a.line - b.line;
}

function comparePackageUse(a: PackageUseManifest, b: PackageUseManifest): number {
  return compareText(a.package, b.package)
    || compareText(a.capability, b.capability)
    || compareLocated(a, b);
}

function compareSemantic(
  a: { readonly id: string | null; readonly name: string; readonly file: string; readonly line: number },
  b: { readonly id: string | null; readonly name: string; readonly file: string; readonly line: number },
): number {
  if (a.id !== null && b.id === null) return -1;
  if (a.id === null && b.id !== null) return 1;
  return compareText(a.id ?? "", b.id ?? "")
    || compareText(a.name, b.name)
    || compareLocated(a, b);
}

function addUnknownPackageDiagnostic(output: MutableManifest): void {
  const inventory = [...output.unknownPackages]
    .sort(([left], [right]) => compareText(left, right))
    .map(([packageName, uses]) => ({
      package: packageName,
      uses: [...new Map(
        uses
          .sort(compareLocated)
          .map((entry) => [`${entry.file}\0${String(entry.line)}`, entry]),
      ).values()],
    }));
  if (inventory.length === 0) return;

  const packageCapabilities: Record<string, string> = {};
  for (const entry of inventory) packageCapabilities[entry.package] = "CHOOSE: pure | ui | external-system | host-io";
  const evidence = inventory
    .map((entry) => `${entry.package}: ${entry.uses.map((use) => `${use.file}:${String(use.line)}`).join(", ")}`)
    .join("; ");
  const firstUse = inventory[0]?.uses[0] ?? { file: "package.json", line: 1 };
  output.diagnostics.push(diagnostic(
    "package-capability",
    `Unknown runtime package capabilities. Inventory: ${evidence}. Starter packageCapabilities map (replace every CHOOSE value): ${JSON.stringify(packageCapabilities)}`,
    firstUse.file,
    firstUse.line,
    {
      ...(inventory.length === 1 && inventory[0] !== undefined ? { target: inventory[0].package } : {}),
      packageCapabilityMigration: { inventory, packageCapabilities },
    },
  ));
}

function uniqueDependencies(dependencies: readonly DependencyManifest[]): DependencyManifest[] {
  const grouped = new Map<string, { entry: DependencyManifest; symbols: Set<string> }>();
  const sorted = [...dependencies]
    .sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to) || compareLocated(a, b));
  for (const entry of sorted) {
    const key = `${entry.from}\0${entry.to}`;
    const current = grouped.get(key);
    if (current === undefined) {
      grouped.set(key, { entry, symbols: new Set(entry.symbols) });
      continue;
    }
    for (const symbol of entry.symbols) current.symbols.add(symbol);
  }
  return [...grouped.values()].map(({ entry, symbols }) => ({
    ...entry,
    symbols: [...symbols].sort(compareText),
  }));
}

export function analyzeTypeContractsWithTypescript(
  applicationRoot: string,
  options: AnalyzeApplicationOptions = {},
): TypeContractAnalysis {
  const root = path.resolve(applicationRoot);
  const loaded = loadProgram(root, options);
  const checker = loaded.program.getTypeChecker();
  const programFiles = loaded.program.getSourceFiles();
  const files = programFiles.filter((sourceFile) => isApplicationSource(root, sourceFile));
  const sourceRoles = new Map(programFiles
    .filter((sourceFile) => inside(path.join(root, "src"), sourceFile.fileName))
    .map((sourceFile) => [
      path.resolve(sourceFile.fileName),
      resolveSourceRole(root, sourceFile),
    ]));
  const selectedPolicy = selectPackagePolicy(root, options);
  const policy = packagePolicyMap(selectedPolicy.entries);
  const blockedPackages = new Set(selectedPolicy.blockedPackages);
  const output: MutableManifest = {
    models: [],
    operations: [],
    routes: [],
    events: [],
    adapters: [],
    permissions: new Set(),
    dependencies: [],
    exceptions: [],
    diagnostics: [],
    adapterContracts: new Map(),
    pendingAdapterLinks: [],
    packagePolicy: [...selectedPolicy.entries],
    packageUses: [],
    unknownPackages: new Map(),
  };
  const callbacks: AnalyzedCallbackTypeContract[] = [];

  for (const issue of selectedPolicy.issues) {
    output.diagnostics.push(diagnostic(
      "package-policy",
      issue.message,
      "package.json",
      1,
      issue.key === undefined ? {} : { target: issue.key },
    ));
  }

  for (const entry of [...loaded.configDiagnostics, ...ts.getPreEmitDiagnostics(loaded.program)]) {
    if (entry.file === undefined || inside(root, entry.file.fileName)) output.diagnostics.push(flattenTsDiagnostic(root, entry));
  }
  for (const sourceFile of files) extractAllowances(root, sourceFile, output);
  for (const sourceFile of files) {
    extractDeclarations(root, sourceFile, checker, output, callbacks);
    checkImports(root, sourceFile, checker, loaded.compilerOptions, sourceRoles, policy, blockedPackages, output);
    checkBoringTypeScript(root, sourceFile, output);
  }

  resolveAdapterLinks(checker, output);
  const featureRecords = discoverFeatures(root, files);
  const features = featureRecords.map((feature) => featureManifest(root, feature, checker, output));
  const semanticRecords = [
    ...features,
    ...features.flatMap((feature) => feature.exports),
    ...output.models,
    ...output.operations,
    ...output.routes,
    ...output.events,
    ...output.adapters,
  ];
  addIdentityDiagnostics(semanticRecords, output);
  addContractDiagnostics(output);
  addDuplicateIdDiagnostics(semanticRecords, output);
  output.dependencies.splice(0, output.dependencies.length, ...uniqueDependencies(output.dependencies));
  addCycleDiagnostics(root, featureRecords, output);
  checkDuplicateOwners(output);
  applyAllowances(output);
  // Unknown classifications cannot be waived because no capability can be emitted for them.
  addUnknownPackageDiagnostic(output);

  features.sort(compareSemantic);
  output.models.sort(compareSemantic);
  output.operations.sort(compareSemantic);
  output.routes.sort(compareSemantic);
  output.events.sort(compareSemantic);
  output.adapters.sort(compareSemantic);
  output.exceptions.sort(compareLocated);
  output.packagePolicy.sort((left, right) => compareText(left.package, right.package));
  output.packageUses.sort(comparePackageUse);
  output.diagnostics.sort((a, b) => compareLocated(a, b) || compareText(a.rule, b.rule) || compareText(a.message, b.message));

  return {
    manifest: {
      version: 2,
      compiler: {
        manifestVersion: 2,
        typescriptVersion: "5.9.3",
        schemaProtocolVersion: SCHEMA_PROTOCOL_VERSION,
        canonicalSchemaVersion: CANONICAL_SCHEMA_VERSION,
        typeContractVersion: TYPE_CONTRACT_VERSION,
      },
      packagePolicy: output.packagePolicy,
      packageUses: output.packageUses,
      features,
      models: output.models,
      operations: output.operations,
      routes: output.routes,
      events: output.events,
      adapters: output.adapters,
      permissions: [...output.permissions].sort(),
      dependencies: output.dependencies,
      exceptions: output.exceptions,
      diagnostics: output.diagnostics,
    },
    callbacks: callbacks.sort((left, right) => compareNamed(left, right)),
  };
}

export function analyzeWithTypescript(applicationRoot: string, options: AnalyzeApplicationOptions = {}): ArchitectureManifest {
  return analyzeTypeContractsWithTypescript(applicationRoot, options).manifest;
}

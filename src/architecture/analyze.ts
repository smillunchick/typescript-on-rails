import { builtinModules } from "node:module";
import path from "node:path";
import ts from "typescript";

import type {
  AdapterManifest,
  AnalyzeApplicationOptions,
  ArchitectureDiagnostic,
  ArchitectureExceptionManifest,
  ArchitectureManifest,
  DependencyManifest,
  EventManifest,
  FeatureManifest,
  ModelManifest,
  OperationManifest,
  PublicExportManifest,
  RouteManifest,
  SourceLocation,
} from "./manifest.js";

const FRAMEWORK_PACKAGE = "typescript-on-rails";
const NETWORK_MODULES = new Set(["http", "https", "http2", "net", "tls", "dns", "dgram"]);
const NODE_MODULES = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const RULE_CODES: Readonly<Record<string, string>> = {
  "architecture-allowance": "ARCH001",
  "public-boundary": "ARCH002",
  "feature-boundary": "ARCH003",
  "feature-cycle": "ARCH004",
  "runtime-boundary": "ARCH005",
  "domain-ui": "ARCH006",
  "external-io": "ARCH007",
  "vendor-type-leak": "ARCH008",
  "boring-typescript": "ARCH009",
  "public-api-type": "ARCH010",
  "data-owner": "ARCH011",
  typescript: "ARCH012",
};

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

interface ImportRecord {
  readonly node: ts.ImportDeclaration;
  readonly specifier: string;
  readonly typeOnly: boolean;
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
  options: { readonly severity?: "error" | "warning"; readonly suggestion?: string; readonly target?: string } = {},
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
  };
}

function featureNameFor(root: string, fileName: string): string | null {
  const relative = slash(path.relative(path.join(root, "src", "features"), fileName));
  if (relative.startsWith("../") || relative === ".." || path.isAbsolute(relative)) return null;
  return relative.split("/")[0] || null;
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
      read.config as object,
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

function frameworkBindings(sourceFile: ts.SourceFile): FrameworkBindings {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== FRAMEWORK_PACKAGE && !statement.moduleSpecifier.text.startsWith(`${FRAMEWORK_PACKAGE}/`)) continue;
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

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const item of object.properties) {
    if (!ts.isPropertyAssignment(item)) continue;
    const itemName = ts.isIdentifier(item.name) || ts.isStringLiteral(item.name) ? item.name.text : undefined;
    if (itemName === name) return item.initializer;
  }
  return undefined;
}

function stringProperty(object: ts.ObjectLiteralExpression, name: string): string | null {
  const value = property(object, name);
  return value !== undefined && ts.isStringLiteralLike(value) ? value.text : null;
}

function objectArgument(call: ts.CallExpression): ts.ObjectLiteralExpression | null {
  const first = call.arguments[0];
  return first !== undefined && ts.isObjectLiteralExpression(first) ? first : null;
}

function variableName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node;
  while (current !== undefined && !ts.isVariableDeclaration(current)) current = current.parent;
  return current !== undefined && ts.isIdentifier(current.name) ? current.name.text : null;
}

function extractDeclarations(root: string, sourceFile: ts.SourceFile, output: MutableManifest): void {
  const bindings = frameworkBindings(sourceFile);
  const feature = featureNameFor(root, sourceFile.fileName);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const primitive = primitiveForCall(node, bindings);
      const nameFromVariable = variableName(node);
      const definition = objectArgument(node);
      if (primitive === "defineModel" && definition !== null) {
        const name = stringProperty(definition, "name") ?? nameFromVariable;
        if (name !== null) output.models.push({ name, feature, ...location(root, sourceFile, node) });
      } else if ((primitive === "action" || primitive === "query") && definition !== null && nameFromVariable !== null) {
        const permission = stringProperty(definition, "permission");
        output.operations.push({
          name: nameFromVariable,
          kind: primitive,
          feature,
          ...location(root, sourceFile, node),
          ...(permission === null ? {} : { permission }),
        });
        if (permission !== null) output.permissions.add(permission);
      } else if (primitive === "route" && definition !== null && nameFromVariable !== null) {
        const permission = stringProperty(definition, "permission");
        output.routes.push({
          name: nameFromVariable,
          method: stringProperty(definition, "method"),
          path: stringProperty(definition, "path"),
          feature,
          ...location(root, sourceFile, node),
          ...(permission === null ? {} : { permission }),
        });
        if (permission !== null) output.permissions.add(permission);
      } else if (primitive === "event" && definition !== null) {
        const name = stringProperty(definition, "name") ?? nameFromVariable;
        if (name !== null) output.events.push({ name, feature, ...location(root, sourceFile, node) });
      } else if (primitive === "defineAdapterContract" && definition !== null) {
        const name = stringProperty(definition, "name") ?? nameFromVariable;
        if (name !== null) output.adapters.push({ name, kind: "contract", feature, ...location(root, sourceFile, node) });
      } else if (primitive === "implementAdapter" && nameFromVariable !== null) {
        output.adapters.push({ name: nameFromVariable, kind: "implementation", feature, ...location(root, sourceFile, node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
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
      const definition = objectArgument(node);
      const rule = definition === null ? null : stringProperty(definition, "rule");
      const reason = definition === null ? null : stringProperty(definition, "reason");
      const expires = definition === null ? null : stringProperty(definition, "expires");
      const target = definition === null ? null : stringProperty(definition, "target");
      let valid = rule !== null && rule.trim() !== "" && reason !== null && reason.trim() !== "";
      let issue: string | null = null;
      if (!valid) issue = "Architecture allowances require a nonblank literal rule and reason";
      if (expires !== null) {
        const parsed = /^\d{4}-\d{2}-\d{2}$/.test(expires) && !Number.isNaN(Date.parse(`${expires}T00:00:00.000Z`));
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

function importsFor(sourceFile: ts.SourceFile, compilerOptions: ts.CompilerOptions): ImportRecord[] {
  const imports: ImportRecord[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    const typeOnly = clause?.isTypeOnly === true
      || (clause?.namedBindings !== undefined
        && ts.isNamedImports(clause.namedBindings)
        && clause.namedBindings.elements.length > 0
        && clause.namedBindings.elements.every((entry) => entry.isTypeOnly));
    const resolved = ts.resolveModuleName(specifier, sourceFile.fileName, compilerOptions, ts.sys).resolvedModule?.resolvedFileName;
    imports.push({ node: statement, specifier, typeOnly, ...(resolved === undefined ? {} : { resolved }) });
  }
  return imports;
}

function packageName(specifier: string): string {
  if (specifier.startsWith("node:")) return specifier;
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0] ?? specifier;
}

function isInfra(root: string, fileName: string): boolean {
  return inside(path.join(root, "src", "infra"), fileName);
}

function pathRole(fileName: string): { readonly client: boolean; readonly domain: boolean; readonly ui: boolean } {
  const normalized = slash(fileName);
  const basename = path.basename(normalized);
  return {
    client: /\.client\.tsx?$/.test(basename),
    domain: /\/(model|schema|policy|actions|queries)\.tsx?$/.test(normalized) || /\/(actions|queries)\//.test(normalized),
    ui: /\/ui\//.test(normalized),
  };
}

function hasUseClient(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) => ts.isExpressionStatement(statement)
      && ts.isStringLiteral(statement.expression)
      && statement.expression.text === "use client",
  );
}

function importedValueDeclarationFiles(checker: ts.TypeChecker, node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (clause === undefined || clause.isTypeOnly) return [];
  const symbols: ts.Symbol[] = [];
  const addSymbol = (name: ts.Identifier): void => {
    const symbol = checker.getSymbolAtLocation(name);
    if (symbol !== undefined) symbols.push(resolvedSymbol(checker, symbol));
  };
  if (clause.name !== undefined) addSymbol(clause.name);
  if (clause.namedBindings !== undefined) {
    if (ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        if (!element.isTypeOnly) addSymbol(element.name);
      }
    } else {
      const namespaceSymbol = checker.getSymbolAtLocation(clause.namedBindings.name);
      if (namespaceSymbol !== undefined) {
        const moduleSymbol = resolvedSymbol(checker, namespaceSymbol);
        for (const exported of checker.getExportsOfModule(moduleSymbol)) symbols.push(resolvedSymbol(checker, exported));
      }
    }
  }
  return [...new Set(symbols.flatMap((symbol) => symbol.declarations ?? []).map((entry) => entry.getSourceFile().fileName))];
}

function checkImports(
  root: string,
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  compilerOptions: ts.CompilerOptions,
  allowedExternalPackages: ReadonlySet<string>,
  output: MutableManifest,
): void {
  const sourceFeature = featureNameFor(root, sourceFile.fileName);
  const sourceRole = pathRole(sourceFile.fileName);
  const client = sourceRole.client || hasUseClient(sourceFile);
  for (const entry of importsFor(sourceFile, compilerOptions)) {
    const importLocation = location(root, sourceFile, entry.node.moduleSpecifier);
    const targetFeature = entry.resolved === undefined ? null : featureNameFor(root, entry.resolved);
    if (sourceFeature !== null && targetFeature !== null && sourceFeature !== targetFeature) {
      output.dependencies.push({ from: sourceFeature, to: targetFeature, ...importLocation });
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

    const targetRole = entry.resolved === undefined ? null : pathRole(entry.resolved);
    const nodeModule = NODE_MODULES.has(entry.specifier);
    if (client && !entry.typeOnly) {
      const runtimeTargets = [
        ...(entry.resolved === undefined ? [] : [entry.resolved]),
        ...importedValueDeclarationFiles(checker, entry.node),
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
          `Client code cannot import server-only module ${entry.specifier}`,
          importLocation.file,
          importLocation.line,
          { target: entry.specifier },
        ));
      }
    }
    if (sourceRole.domain && targetRole?.ui === true) {
      output.diagnostics.push(diagnostic(
        "domain-ui",
        `Domain code cannot import UI module ${entry.specifier}`,
        importLocation.file,
        importLocation.line,
        { target: entry.specifier },
      ));
    }

    const packageTarget = packageName(entry.specifier);
    const isInternal = entry.resolved !== undefined && inside(path.join(root, "src"), entry.resolved);
    const networkModule = NETWORK_MODULES.has(entry.specifier.replace(/^node:/, ""));
    const externalPackage = !entry.specifier.startsWith(".")
      && !isInternal
      && !nodeModule
      && packageTarget !== FRAMEWORK_PACKAGE;
    if (
      !isInfra(root, sourceFile.fileName)
      && !allowedExternalPackages.has(packageTarget)
      && ((networkModule && !entry.typeOnly) || externalPackage)
    ) {
      output.diagnostics.push(diagnostic(
        "external-io",
        `External IO dependency ${entry.specifier} must be imported from src/infra`,
        importLocation.file,
        importLocation.line,
        { target: packageTarget },
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
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      report(node, "Dynamic import() is not allowed");
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
  if (feature.boundary === undefined) {
    const file = relativeFile(root, feature.directory);
    output.diagnostics.push(diagnostic(
      "public-boundary",
      `Feature ${feature.name} must define one public boundary at index.ts`,
      file,
      1,
      { suggestion: `Create src/features/${feature.name}/index.ts` },
    ));
    return { name: feature.name, publicBoundary: null, exports, file, line: 1 };
  }

  const moduleSymbol = checker.getSymbolAtLocation(feature.boundary);
  for (const exported of moduleSymbol === undefined ? [] : checker.getExportsOfModule(moduleSymbol)) {
    const symbol = resolvedSymbol(checker, exported);
    const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0] ?? feature.boundary;
    const entry = { name: exported.name, kind: symbolKind(symbol), ...location(root, declaration.getSourceFile(), declaration) };
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
  exports.sort(compareNamed);
  const point = location(root, feature.boundary, feature.boundary);
  return { name: feature.name, publicBoundary: point.file, exports, ...point };
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

function uniqueDependencies(dependencies: readonly DependencyManifest[]): DependencyManifest[] {
  const seen = new Set<string>();
  return [...dependencies]
    .sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to) || compareLocated(a, b))
    .filter((entry) => {
      const key = `${entry.from}\0${entry.to}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function analyzeApplication(applicationRoot: string, options: AnalyzeApplicationOptions = {}): ArchitectureManifest {
  const root = path.resolve(applicationRoot);
  const loaded = loadProgram(root, options);
  const checker = loaded.program.getTypeChecker();
  const files = loaded.program.getSourceFiles().filter((sourceFile) => isApplicationSource(root, sourceFile));
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
  };
  const allowedExternalPackages = new Set(options.allowedExternalPackages ?? []);

  for (const entry of [...loaded.configDiagnostics, ...ts.getPreEmitDiagnostics(loaded.program)]) {
    if (entry.file === undefined || inside(root, entry.file.fileName)) output.diagnostics.push(flattenTsDiagnostic(root, entry));
  }
  for (const sourceFile of files) extractAllowances(root, sourceFile, output);
  for (const sourceFile of files) {
    extractDeclarations(root, sourceFile, output);
    checkImports(root, sourceFile, checker, loaded.compilerOptions, allowedExternalPackages, output);
    checkBoringTypeScript(root, sourceFile, output);
  }

  const featureRecords = discoverFeatures(root, files);
  const features = featureRecords.map((feature) => featureManifest(root, feature, checker, output));
  output.dependencies.splice(0, output.dependencies.length, ...uniqueDependencies(output.dependencies));
  addCycleDiagnostics(root, featureRecords, output);
  checkDuplicateOwners(output);
  applyAllowances(output);

  output.models.sort(compareNamed);
  output.operations.sort(compareNamed);
  output.routes.sort(compareNamed);
  output.events.sort(compareNamed);
  output.adapters.sort(compareNamed);
  output.exceptions.sort(compareLocated);
  output.diagnostics.sort((a, b) => compareLocated(a, b) || compareText(a.rule, b.rule) || compareText(a.message, b.message));

  return {
    version: 1,
    root: slash(root),
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
  };
}

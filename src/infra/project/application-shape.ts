import ts from "typescript";

export type FeatureArtifactCollection = "models" | "operations";

export interface FeatureRegistrationSourceEdit {
  readonly feature: string;
  readonly symbol: string;
  readonly module: string;
  readonly collection: FeatureArtifactCollection;
}

export interface AppRegistrationSourceEdit {
  readonly symbol: string;
  readonly module: string;
}

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly order: number;
}

function sourceFile(source: string): ts.SourceFile {
  return ts.createSourceFile("registration.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function propertyName(node: ts.ObjectLiteralElementLike): string | undefined {
  if (!("name" in node) || node.name === undefined) return undefined;
  if (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) return node.name.text;
  return undefined;
}

function stringProperty(object: ts.ObjectLiteralExpression, name: string): string | undefined {
  const property = object.properties.find((item) => propertyName(item) === name);
  return property !== undefined && ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)
    ? property.initializer.text
    : undefined;
}

function callObject(call: ts.CallExpression, name: string, errorCode: string): ts.ObjectLiteralExpression {
  const argument = call.arguments[0];
  if (!ts.isIdentifier(call.expression) || call.expression.text !== name || call.arguments.length !== 1 || argument === undefined || !ts.isObjectLiteralExpression(argument)) {
    throw new TypeError(errorCode);
  }
  return argument;
}

function assertCanonicalMembers(object: ts.ObjectLiteralExpression, errorCode: string): void {
  if (object.properties.some((property) => !ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))) {
    throw new TypeError(errorCode);
  }
}

function hasExportModifier(statement: ts.VariableStatement): boolean {
  return ts.getModifiers(statement)?.some(({ kind }) => kind === ts.SyntaxKind.ExportKeyword) === true;
}

function featureRegistration(file: ts.SourceFile, feature: string): { readonly statement: ts.VariableStatement; readonly object: ts.ObjectLiteralExpression } {
  const values: Array<{ readonly statement: ts.VariableStatement; readonly object: ts.ObjectLiteralExpression }> = [];
  let registrations = 0;
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.initializer === undefined || !ts.isCallExpression(declaration.initializer) || !ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== "defineFeature") continue;
      registrations += 1;
      const object = callObject(declaration.initializer, "defineFeature", "FEATURE_REGISTRATION_SHAPE_AMBIGUOUS");
      assertCanonicalMembers(object, "FEATURE_REGISTRATION_SHAPE_AMBIGUOUS");
      if (stringProperty(object, "name") === feature) values.push({ statement, object });
    }
  }
  if (registrations !== 1 || values.length !== 1 || values[0] === undefined) throw new TypeError("FEATURE_REGISTRATION_SHAPE_AMBIGUOUS");
  return values[0];
}

function appRegistration(file: ts.SourceFile): ts.ObjectLiteralExpression {
  const values: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineApp") {
      const object = callObject(node, "defineApp", "APP_REGISTRATION_SHAPE_AMBIGUOUS");
      assertCanonicalMembers(object, "APP_REGISTRATION_SHAPE_AMBIGUOUS");
      values.push(object);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (values.length !== 1 || values[0] === undefined) throw new TypeError("APP_REGISTRATION_SHAPE_AMBIGUOUS");
  return values[0];
}

function assertIdentifier(value: string): void {
  if (!/^[$A-Z_a-z][$\w]*$/.test(value)) throw new TypeError(`APPLICATION_SHAPE_INVALID_IDENTIFIER:${value}`);
}

function namedBindingHasSymbol(clause: ts.NamedImports, symbol: string): boolean {
  return clause.elements.some((element) => element.name.text === symbol && element.propertyName === undefined);
}

function bindingNames(name: ts.BindingName): readonly string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

function statementDeclaresSymbol(statement: ts.Statement, symbol: string): boolean {
  if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.some(({ name }) => bindingNames(name).includes(symbol));
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name !== undefined) return statement.name.text === symbol;
  return false;
}

function importEdit(file: ts.SourceFile, symbol: string, module: string, order: number): TextEdit | undefined {
  const imports = file.statements.filter(ts.isImportDeclaration);
  for (const statement of imports) {
    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (clause?.name?.text === symbol) throw new TypeError(`APPLICATION_SHAPE_IMPORT_CONFLICT:${symbol}`);
    const bindings = clause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings) && bindings.name.text === symbol) throw new TypeError(`APPLICATION_SHAPE_IMPORT_CONFLICT:${symbol}`);
    if (bindings !== undefined && ts.isNamedImports(bindings) && bindings.elements.some((element) => element.name.text === symbol)) {
      if (statement.moduleSpecifier.text === module && namedBindingHasSymbol(bindings, symbol)) return undefined;
      throw new TypeError(`APPLICATION_SHAPE_IMPORT_CONFLICT:${symbol}`);
    }
  }
  if (file.statements.some((statement) => !ts.isImportDeclaration(statement) && statementDeclaresSymbol(statement, symbol))) {
    throw new TypeError(`APPLICATION_SHAPE_SYMBOL_CONFLICT:${symbol}`);
  }
  const position = imports.at(-1)?.end ?? 0;
  const prefix = position === 0 ? "" : "\n";
  return { start: position, end: position, text: `${prefix}import { ${symbol} } from ${JSON.stringify(module)};`, order };
}

function exportEdit(file: ts.SourceFile, registration: ts.VariableStatement, symbol: string, module: string, order: number): TextEdit | undefined {
  const exports = file.statements.filter(ts.isExportDeclaration);
  for (const statement of exports) {
    if (statement.exportClause === undefined || !ts.isNamedExports(statement.exportClause) || statement.moduleSpecifier === undefined || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    if (statement.exportClause.elements.some((element) => element.name.text === symbol)) {
      if (statement.moduleSpecifier.text === module) return undefined;
      throw new TypeError(`APPLICATION_SHAPE_EXPORT_CONFLICT:${symbol}`);
    }
  }
  const position = registration.getFullStart();
  const prefix = position === 0 ? "" : exports.length === 0 ? "\n\n" : "\n";
  return { start: position, end: position, text: `${prefix}export { ${symbol} } from ${JSON.stringify(module)};`, order };
}

function arrayHasSymbol(array: ts.ArrayLiteralExpression, symbol: string, errorCode: string): boolean {
  if (array.elements.some((element) => !ts.isIdentifier(element))) throw new TypeError(errorCode);
  return array.elements.some((element) => ts.isIdentifier(element) && element.text === symbol);
}

function objectHasSymbol(object: ts.ObjectLiteralExpression, symbol: string): boolean {
  if (object.properties.some((property) => !ts.isShorthandPropertyAssignment(property))) throw new TypeError("FEATURE_REGISTRATION_SHAPE_AMBIGUOUS");
  return object.properties.some((property) => ts.isShorthandPropertyAssignment(property) && property.name.text === symbol);
}

function appendToContainer(container: ts.ArrayLiteralExpression | ts.ObjectLiteralExpression, symbol: string, order: number): TextEdit {
  const items = ts.isArrayLiteralExpression(container) ? container.elements : container.properties;
  const empty = items.length === 0;
  const position = empty ? container.end - 1 : (items.at(-1)?.end ?? container.end - 1);
  return { start: position, end: position, text: empty ? symbol : `, ${symbol}`, order };
}

function addObjectProperty(object: ts.ObjectLiteralExpression, name: string, value: string, order: number): TextEdit {
  const empty = object.properties.length === 0;
  const position = empty ? object.end - 1 : (object.properties.at(-1)?.end ?? object.end - 1);
  return { start: position, end: position, text: empty ? ` ${name}: ${value} ` : `, ${name}: ${value}`, order };
}

function collectionEdit(object: ts.ObjectLiteralExpression, collection: FeatureArtifactCollection, symbol: string, order: number): TextEdit | undefined {
  const property = object.properties.find((item) => propertyName(item) === collection);
  if (property === undefined) return addObjectProperty(object, collection, collection === "models" ? `[${symbol}]` : `{ ${symbol} }`, order);
  if (!ts.isPropertyAssignment(property)) throw new TypeError("FEATURE_REGISTRATION_SHAPE_AMBIGUOUS");
  if (collection === "models") {
    if (!ts.isArrayLiteralExpression(property.initializer)) throw new TypeError("FEATURE_REGISTRATION_SHAPE_AMBIGUOUS");
    return arrayHasSymbol(property.initializer, symbol, "FEATURE_REGISTRATION_SHAPE_AMBIGUOUS") ? undefined : appendToContainer(property.initializer, symbol, order);
  }
  if (!ts.isObjectLiteralExpression(property.initializer)) throw new TypeError("FEATURE_REGISTRATION_SHAPE_AMBIGUOUS");
  return objectHasSymbol(property.initializer, symbol) ? undefined : appendToContainer(property.initializer, symbol, order);
}

function featuresEdit(object: ts.ObjectLiteralExpression, symbol: string, order: number): TextEdit | undefined {
  const property = object.properties.find((item) => propertyName(item) === "features");
  if (property === undefined) return addObjectProperty(object, "features", `[${symbol}]`, order);
  if (!ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer)) throw new TypeError("APP_REGISTRATION_SHAPE_AMBIGUOUS");
  return arrayHasSymbol(property.initializer, symbol, "APP_REGISTRATION_SHAPE_AMBIGUOUS") ? undefined : appendToContainer(property.initializer, symbol, order);
}

function applyTextEdits(source: string, edits: readonly (TextEdit | undefined)[]): string {
  const selected = edits.filter((edit): edit is TextEdit => edit !== undefined)
    .sort((left, right) => right.start - left.start || right.order - left.order);
  let output = source;
  for (const edit of selected) output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
  return output;
}

export function validateFeatureRegistrationSource(source: string, feature: string): void {
  featureRegistration(sourceFile(source), feature);
}

export function updateFeatureRegistrationSource(source: string, edit: FeatureRegistrationSourceEdit): string {
  assertIdentifier(edit.symbol);
  const file = sourceFile(source);
  const registration = featureRegistration(file, edit.feature);
  return applyTextEdits(source, [
    importEdit(file, edit.symbol, edit.module, 1),
    exportEdit(file, registration.statement, edit.symbol, edit.module, 2),
    collectionEdit(registration.object, edit.collection, edit.symbol, 3),
  ]);
}

export function updateAppRegistrationSource(source: string, edit: AppRegistrationSourceEdit): string {
  assertIdentifier(edit.symbol);
  const file = sourceFile(source);
  const registration = appRegistration(file);
  return applyTextEdits(source, [
    importEdit(file, edit.symbol, edit.module, 1),
    featuresEdit(registration, edit.symbol, 2),
  ]);
}

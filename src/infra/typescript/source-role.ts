import path from "node:path";
import ts from "typescript";

export type SourceRole = "infrastructure" | "ui/client" | "domain" | "application";

export interface SourceRoleSignal {
  readonly role: Exclude<SourceRole, "application">;
  readonly signal: "src/infra path" | "/ui/ path" | ".client.ts/.tsx suffix" | '"use client" directive' | "domain convention";
}

export interface SourceRoleResolution {
  readonly signals: readonly SourceRoleSignal[];
  readonly explicitRoles: readonly Exclude<SourceRole, "application">[];
  readonly effectiveRoles: readonly SourceRole[];
  readonly conflict: boolean;
}

const ROLE_ORDER: readonly Exclude<SourceRole, "application">[] = [
  "infrastructure",
  "ui/client",
  "domain",
];

function slash(value: string): string {
  return value.split(path.sep).join("/");
}

function inside(root: string, fileName: string): boolean {
  const relative = path.relative(root, fileName);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function hasUseClient(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some(
    (statement) => ts.isExpressionStatement(statement)
      && ts.isStringLiteral(statement.expression)
      && statement.expression.text === "use client",
  );
}

export function resolveSourceRole(root: string, sourceFile: ts.SourceFile): SourceRoleResolution {
  const relative = slash(path.relative(root, sourceFile.fileName));
  const basename = path.basename(relative);
  const signals: SourceRoleSignal[] = [];

  if (inside(path.join(root, "src", "infra"), sourceFile.fileName)) {
    signals.push({ role: "infrastructure", signal: "src/infra path" });
  }
  if (/\/ui\//.test(relative)) signals.push({ role: "ui/client", signal: "/ui/ path" });
  if (/\.client\.tsx?$/.test(basename)) {
    signals.push({ role: "ui/client", signal: ".client.ts/.tsx suffix" });
  }
  if (hasUseClient(sourceFile)) signals.push({ role: "ui/client", signal: '"use client" directive' });
  if (/\/(model|schema|policy|actions|queries)\.tsx?$/.test(relative) || /\/(actions|queries)\//.test(relative)) {
    signals.push({ role: "domain", signal: "domain convention" });
  }

  const found = new Set(signals.map((entry) => entry.role));
  const explicitRoles = ROLE_ORDER.filter((role) => found.has(role));
  const effectiveRoles: readonly SourceRole[] = explicitRoles.length === 0 ? ["application"] : explicitRoles;
  return { signals, explicitRoles, effectiveRoles, conflict: explicitRoles.length > 1 };
}

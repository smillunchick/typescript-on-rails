import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export interface AppFixture {
  readonly root: string;
  write(relativePath: string, content: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createAppFixture(files: Readonly<Record<string, string>>): Promise<AppFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "typescript-on-rails-"));
  const frameworkEntry = path.resolve("src/index.ts");
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      baseUrl: ".",
      typeRoots: [path.resolve("node_modules/@types")],
      paths: {
        "@/features/*": ["src/features/*/index.ts"],
        "@/*": ["src/*"],
        "typescript-on-rails": [frameworkEntry],
      },
    },
    include: ["src/**/*.ts", "src/**/*.tsx"],
  };

  await writeFile(path.join(root, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`);
  const fixture: AppFixture = {
    root,
    async write(relativePath, content) {
      const absolutePath = path.join(root, relativePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content);
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };

  for (const [relativePath, content] of Object.entries(files)) {
    await fixture.write(relativePath, content);
  }
  return fixture;
}

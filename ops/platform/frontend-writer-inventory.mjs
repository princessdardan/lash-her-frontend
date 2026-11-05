import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const demand = (ok) => { if (!ok) throw new Error("FRONTEND_WRITER_INVENTORY_REFUSED"); };
const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const directive = (statements) => statements.some((node) => ts.isExpressionStatement(node) &&
  ts.isStringLiteral(node.expression) && node.expression.text === "use server");
const exported = (node) => node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);

function files(root, directory) {
  const path = join(root, directory);
  demand(!lstatSync(path).isSymbolicLink() && lstatSync(path).isDirectory());
  return readdirSync(path).sort().flatMap((name) => {
    const entry = join(path, name), stat = lstatSync(entry);
    demand(!stat.isSymbolicLink());
    return stat.isDirectory() ? files(root, relative(root, entry)) :
      /\.(?:[cm]?[jt]sx?)$/u.test(name) && !/\.(?:test|spec)\./u.test(name) ? [entry] : [];
  });
}

function names(statement) {
  const bindingNames = (node) => {
    if (ts.isIdentifier(node)) return [node.text];
    demand(ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node));
    return node.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
  };
  if (exported(statement)) {
    if (statement.modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return ["default"];
    if (ts.isFunctionDeclaration(statement)) { demand(statement.name); return [statement.name.text]; }
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap((node) => bindingNames(node.name));
  }
  if (ts.isExportAssignment(statement)) { demand(!statement.isExportEquals); return ["default"]; }
  if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
    // An export-star cannot establish the complete public method/action set.
    demand(statement.exportClause && ts.isNamedExports(statement.exportClause));
    return statement.exportClause.elements.filter((node) => !node.isTypeOnly).map((node) => node.name.text);
  }
  return [];
}

export function frontendWriterInventory(root) {
  root = resolve(root);
  const entries = [], actionModules = [], renderEntries = [], manualEntries = [], inlineActions = [], deferredSites = [], databaseConstructors = [], schedules = [];
  const sourceFiles = [...files(root, "src"), ...files(root, "scripts"), join(root, "ops/platform/vercel-config.mjs")].sort();
  const manifest = {};
  for (const path of sourceFiles) {
    demand(!lstatSync(path).isSymbolicLink());
    const file = relative(root, path).split("\\").join("/"), bytes = readFileSync(path);
    manifest[file] = hash(bytes);
    const tree = ts.createSourceFile(file, bytes.toString("utf8"), ts.ScriptTarget.Latest, true);
    demand(tree.parseDiagnostics.length === 0);
    const serverModule = directive(tree.statements), routeModule = /^src\/app\/(?:.*\/)?route\.[jt]s$/u.test(file);
    const renderModule = /^src\/app\/(?:.*\/)?(?:page|layout)\.[jt]sx?$/u.test(file), manualModule = file.startsWith("scripts/");
    const publicNames = serverModule || routeModule || renderModule || manualModule ? [...new Set(tree.statements.flatMap(names))].sort() : [];
    if (routeModule) {
      const exportedMethods = publicNames.filter((name) => methods.has(name));
      demand(exportedMethods.length > 0);
      entries.push({ file, methods: exportedMethods, sourceSha256: manifest[file], classification: "REVIEW_REQUIRED" });
    }
    if (serverModule) actionModules.push({ file, exports: publicNames, sourceSha256: manifest[file], classification: "REVIEW_REQUIRED" });
    if (renderModule) {
      demand(publicNames.includes("default"));
      const client = tree.statements.some(node => ts.isExpressionStatement(node) && ts.isStringLiteral(node.expression) && node.expression.text === "use client");
      renderEntries.push({ file, exports: publicNames.filter(name => ["default", "generateMetadata", "generateViewport", "generateStaticParams"].includes(name)),
        runtime: client ? "client" : "server", sourceSha256: manifest[file], classification: "REVIEW_REQUIRED" });
    }
    if (manualModule) manualEntries.push({ file, exports: publicNames, sourceSha256: manifest[file], classification: "REVIEW_REQUIRED" });
    const deferredNames = new Set(["after", "waitUntil"]), constructorNames = new Set(["Pool", "Client"]);
    for (const statement of tree.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause?.namedBindings || !ts.isNamedImports(statement.importClause.namedBindings)) continue;
      const moduleName = statement.moduleSpecifier.text;
      for (const binding of statement.importClause.namedBindings.elements) {
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (["next/server", "@vercel/functions"].includes(moduleName) && ["after", "waitUntil"].includes(imported)) deferredNames.add(binding.name.text);
        if (moduleName === "pg" && ["Pool", "Client"].includes(imported)) constructorNames.add(binding.name.text);
      }
    }
    const location = (node) => ({ file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
    const visit = (node) => {
      if (ts.isFunctionLike(node) && node.body && ts.isBlock(node.body) && directive(node.body.statements))
        inlineActions.push({ ...location(node), classification: "REVIEW_REQUIRED" });
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        if (ts.isIdentifier(callee) && deferredNames.has(callee.text) || ts.isPropertyAccessExpression(callee) && deferredNames.has(callee.name.text))
          deferredSites.push({ ...location(node), callee: callee.getText(tree), classification: "REVIEW_REQUIRED" });
      }
      if (ts.isNewExpression(node) && (ts.isIdentifier(node.expression) && constructorNames.has(node.expression.text) ||
          ts.isPropertyAccessExpression(node.expression) && constructorNames.has(node.expression.name.text)))
        databaseConstructors.push({ ...location(node), callee: node.expression.getText(tree), classification: "REVIEW_REQUIRED" });
      if (file === "ops/platform/vercel-config.mjs" && ts.isObjectLiteralExpression(node)) {
        const value = (name) => node.properties.find((p) => ts.isPropertyAssignment(p) &&
          (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name)?.initializer;
        const path = value("path"), schedule = value("schedule");
        if (path && schedule) {
          demand(ts.isStringLiteral(path) && ts.isStringLiteral(schedule));
          schedules.push({ path: path.text, schedule: schedule.text });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return { version: 2, scope: "candidate-source-only", sourceManifestSha256: hash(JSON.stringify(manifest)),
    deploymentInventoryVerified: false, writerFenceVerified: false, drainVerified: false,
    routes: entries, actionModules, renderEntries, manualEntries, inlineActions, deferredSites, databaseConstructors, schedules };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    demand(process.argv.length === 2);
    console.log(JSON.stringify(frontendWriterInventory(resolve(fileURLToPath(new URL("../..", import.meta.url))))));
  } catch { console.error("FRONTEND_WRITER_INVENTORY_REFUSED"); process.exitCode = 1; }
}

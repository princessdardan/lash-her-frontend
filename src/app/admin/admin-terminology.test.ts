import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const LEGACY_TERM = /\bemployees?\b/i;
const USER_VISIBLE_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "ariaLabel",
  "caption",
  "confirmation",
  "label",
  "placeholder",
  "title",
]);
const UI_ROOTS = [
  fileURLToPath(new URL("./", import.meta.url)),
  fileURLToPath(new URL("../../components/admin/", import.meta.url)),
];

test("admin JSX does not render legacy employee terminology or raw role values", () => {
  const violations = UI_ROOTS.flatMap(listRuntimeTsxFiles).flatMap((file) =>
    findViolations(file, readFileSync(file, "utf8")),
  );

  assert.deepEqual(violations, []);
});

test("admin JSX guard catches direct legacy copy and arbitrary raw role objects", () => {
  const violations = findViolations(
    "synthetic.tsx",
    `const view = <><p>{"employee"}</p><p>{staff.role}</p></>;`,
  );

  assert.equal(violations.length, 2);
  assert.match(violations[0] ?? "", /legacy visible expression copy/);
  assert.match(violations[1] ?? "", /raw internal role/);
});

test("admin JSX guard permits internal role comparisons and mapped labels", () => {
  const violations = findViolations(
    "synthetic.tsx",
    `const view = <p>{staff.role === "employee" ? getAdminRoleLabel(staff.role) : "Owner"}</p>;`,
  );

  assert.deepEqual(violations, []);
});

function findViolations(file: string, source: string): string[] {
  const violations: string[] = [];
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  function record(node: ts.Node, reason: string) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    violations.push(`${file}:${line + 1} ${reason}`);
  }

  function visit(node: ts.Node) {
    if (ts.isJsxText(node) && LEGACY_TERM.test(node.getText(sourceFile))) {
      record(node, "contains legacy visible copy");
    }

    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(sourceFile);
      if (
        USER_VISIBLE_ATTRIBUTES.has(name) &&
        node.initializer &&
        LEGACY_TERM.test(node.initializer.getText(sourceFile))
      ) {
        record(node, `contains legacy ${name} copy`);
      }
    }

    if (ts.isJsxExpression(node) && node.expression) {
      if (isRoleReference(unwrapExpression(node.expression))) {
        record(node, "renders a raw internal role");
      }

      const renderedChild =
        ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent);
      if (renderedChild) {
        visitRenderedExpressionLiterals(node.expression, (literal) => {
          if (
            LEGACY_TERM.test(literal.text) &&
            !isInternalRoleComparisonLiteral(literal)
          ) {
            record(literal, "contains legacy visible expression copy");
          }
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function listRuntimeTsxFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return listRuntimeTsxFiles(entryPath);
    if (
      entry.isFile() &&
      entry.name.endsWith(".tsx") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      return [entryPath];
    }
    return [];
  });
}

function visitRenderedExpressionLiterals(
  node: ts.Node,
  visit: (literal: ts.StringLiteral) => void,
) {
  if (
    ts.isJsxElement(node) ||
    ts.isJsxFragment(node) ||
    ts.isJsxSelfClosingElement(node)
  ) {
    return;
  }
  if (ts.isStringLiteral(node)) visit(node);
  ts.forEachChild(node, (child) =>
    visitRenderedExpressionLiterals(child, visit),
  );
}

function isInternalRoleComparisonLiteral(literal: ts.StringLiteral): boolean {
  const comparison = literal.parent;
  if (
    !ts.isBinaryExpression(comparison) ||
    ![
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(comparison.operatorToken.kind)
  ) {
    return false;
  }

  const otherOperand =
    comparison.left === literal ? comparison.right : comparison.left;
  return isRoleReference(unwrapExpression(otherOperand));
}

function isRoleReference(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return expression.text === "role";
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text === "role";
  }
  if (ts.isElementAccessExpression(expression)) {
    const argument = expression.argumentExpression;
    return ts.isStringLiteral(argument) && argument.text === "role";
  }
  return false;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

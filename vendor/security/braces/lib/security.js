'use strict';

// Fixed ceiling: callers may not disable this with expansion/length options.
const MAX_DEPTH = 128;

const assertDepth = depth => {
  if (depth > MAX_DEPTH) {
    const error = new SyntaxError(`Brace pattern nesting exceeds maximum depth (${MAX_DEPTH})`);
    error.code = 'ERR_BRACES_MAX_DEPTH';
    throw error;
  }
};

// Iterative preflight also protects callers passing an AST directly. Ignore the
// parser's intentional parent/prev back references; only nodes are traversed.
const validateAst = ast => {
  const active = new Set();
  const stack = [{ node: ast, depth: ast.type === 'root' ? 0 : 1 }];
  while (stack.length) {
    const { node, depth, exit } = stack.pop();
    if (exit) {
      active.delete(node);
      continue;
    }
    if (!node || !Array.isArray(node.nodes)) continue;
    assertDepth(depth);
    if (active.has(node)) {
      const error = new SyntaxError('Cyclic brace AST');
      error.code = 'ERR_BRACES_CYCLIC_AST';
      throw error;
    }
    active.add(node);
    stack.push({ node, exit: true });
    for (let i = node.nodes.length - 1; i >= 0; i--) {
      stack.push({ node: node.nodes[i], depth: depth + 1 });
    }
  }
};

module.exports = { assertDepth, validateAst };

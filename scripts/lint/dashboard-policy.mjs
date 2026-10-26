/** Retain the former noImplicitAnyLet policy without a separate TypeScript parser. */
export default {
  meta: { name: 'dashboard-policy' },
  rules: {
    'no-implicit-any-let': {
      create(context) {
        if (!/\.(?:ts|tsx|mts|cts)$/.test(context.filename)) return {};
        return {
          VariableDeclarator(node) {
            const declaration = node.parent;
            if (
              node.id.type !== 'Identifier' ||
              node.id.typeAnnotation ||
              node.init ||
              declaration.kind === 'const'
            ) return;
            if (
              declaration.parent.type === 'ForInStatement' ||
              declaration.parent.type === 'ForOfStatement'
            ) return;
            context.report({
              node: node.id,
              message: `"${node.id.name}" needs a type annotation or initializer`,
            });
          },
        };
      },
    },
  },
};

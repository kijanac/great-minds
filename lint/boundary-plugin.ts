type AstNode = { readonly type: string } & Record<string, unknown>;

type RuleContext = {
  report(descriptor: { node: AstNode; message: string }): void;
};

type Rule = {
  meta: {
    type: "suggestion";
    docs: { description: string };
  };
  create(context: RuleContext): Record<string, (node: AstNode) => void>;
};

type Plugin = {
  meta: { name: string };
  rules: Record<string, Rule>;
};

const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof (value as AstNode).type === "string";

const asNode = (value: unknown): AstNode | undefined => (isNode(value) ? value : undefined);

const nodeList = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);

const isStringLiteral = (value: unknown): boolean => {
  const node = asNode(value);
  return node?.type === "Literal" && typeof node.value === "string";
};

const containsComputedAccessWith = (value: unknown, keyName: string): boolean => {
  if (Array.isArray(value)) {
    return value.some((item) => containsComputedAccessWith(item, keyName));
  }
  if (!isNode(value)) {
    return false;
  }
  if (value.type === "MemberExpression" && value.computed === true) {
    const property = asNode(value.property);
    if (property?.type === "Identifier" && property.name === keyName) {
      return true;
    }
  }
  return Object.entries(value).some(
    ([key, child]) =>
      key !== "type" &&
      key !== "parent" &&
      key !== "loc" &&
      key !== "range" &&
      containsComputedAccessWith(child, keyName),
  );
};

const noAlternateKeyProbing: Rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Iterating alternate property spellings to probe a value is shotgun parsing; decode the one real contract with a Schema at the boundary.",
    },
  },
  create(context) {
    return {
      ForOfStatement(node) {
        const right = asNode(node.right);
        const left = asNode(node.left);
        if (right?.type !== "ArrayExpression" || left?.type !== "VariableDeclaration") {
          return;
        }
        const elements = nodeList(right.elements);
        if (elements.length < 2 || !elements.every(isStringLiteral)) {
          return;
        }
        const declaration = asNode(nodeList(left.declarations)[0]);
        const id = asNode(declaration?.id);
        if (id?.type !== "Identifier" || typeof id.name !== "string") {
          return;
        }
        if (containsComputedAccessWith(node.body, id.name)) {
          context.report({
            node,
            message: `Probes ${elements.length} alternate key spellings on a value — decode the actual contract with a Schema instead`,
          });
        }
      },
    };
  },
};

const noUnknownRecordCast: Rule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Casting to Record<string, unknown> starts hand-rolled shape probing; decode external data with a Schema at the boundary.",
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        if (asNode(node.expression)?.type === "ObjectExpression") {
          return;
        }
        const annotation = asNode(node.typeAnnotation);
        if (annotation?.type !== "TSTypeReference") {
          return;
        }
        const typeName = asNode(annotation.typeName);
        const params = nodeList(asNode(annotation.typeArguments)?.params);
        if (
          typeName?.type === "Identifier" &&
          typeName.name === "Record" &&
          params.length === 2 &&
          asNode(params[0])?.type === "TSStringKeyword" &&
          asNode(params[1])?.type === "TSUnknownKeyword"
        ) {
          context.report({
            node,
            message:
              "Cast to Record<string, unknown> — decode with a Schema at the boundary instead of probing shapes by hand",
          });
        }
      },
    };
  },
};

const plugin: Plugin = {
  meta: { name: "boundary" },
  rules: {
    "no-alternate-key-probing": noAlternateKeyProbing,
    "no-unknown-record-cast": noUnknownRecordCast,
  },
};

export default plugin;

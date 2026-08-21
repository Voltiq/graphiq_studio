import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Dev-only benchmark/verification scripts run under Node, not Next: they use
    // CommonJS require() and print to the console, both of which the app config
    // rightly forbids. Linting them under app rules made `npm run lint` fail
    // unconditionally from the commit that introduced tools/.
    "tools/**",
  ]),
  {
    rules: {
      /* Restore the conventional "deliberately unused" escapes, which the Next
         preset leaves off. Both matter here and neither weakens the rule:

         ignoreRestSiblings — `const { maxSize: _unused, ...rest } = line` is the
           idiomatic way to STRIP a key, and the named sibling is unused by
           construction. It is typescript-eslint's own default.
         the ^_ patterns — a leading underscore is the long-standing signal for
           "required by a signature, not used by the body". Without it the only
           way to satisfy the rule is to delete a parameter that has to be there. */
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          ignoreRestSiblings: true,
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
]);

export default eslintConfig;

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
]);

export default eslintConfig;

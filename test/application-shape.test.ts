import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  updateAppRegistrationSource,
  updateFeatureRegistrationSource,
} from "../src/infra/project/index.js";

describe("canonical application source edits", () => {
  it("adds exact feature artifacts and app registration without rewriting unrelated code", () => {
    const featureSource = [
      'import { defineFeature } from "typescript-on-rails";',
      "",
      "// Keep this feature note.",
      'export const billingFeature = defineFeature({ name: "billing" });',
      "",
    ].join("\n");
    const withModel = updateFeatureRegistrationSource(featureSource, {
      feature: "billing",
      symbol: "Invoice",
      module: "./invoice.js",
      collection: "models",
    });
    const withOperation = updateFeatureRegistrationSource(withModel, {
      feature: "billing",
      symbol: "approveInvoice",
      module: "./approve-invoice.js",
      collection: "operations",
    });

    assert.match(withOperation, /import \{ Invoice \} from "\.\/invoice\.js";/);
    assert.match(withOperation, /import \{ approveInvoice \} from "\.\/approve-invoice\.js";/);
    assert.match(withOperation, /export \{ Invoice \} from "\.\/invoice\.js";/);
    assert.match(withOperation, /export \{ approveInvoice \} from "\.\/approve-invoice\.js";/);
    assert.match(withOperation, /models:\s*\[Invoice\]/);
    assert.match(withOperation, /operations:\s*\{ approveInvoice \}/);
    assert.match(withOperation, /Keep this feature note/);
    assert.equal(updateFeatureRegistrationSource(withOperation, {
      feature: "billing",
      symbol: "approveInvoice",
      module: "./approve-invoice.js",
      collection: "operations",
    }), withOperation);

    const appSource = [
      'import { defineApp } from "typescript-on-rails";',
      "",
      "// Keep this app note.",
      "export const application = defineApp({});",
      "",
    ].join("\n");
    const registered = updateAppRegistrationSource(appSource, {
      symbol: "billingFeature",
      module: "./features/billing/index.js",
    });
    assert.match(registered, /import \{ billingFeature \} from "\.\/features\/billing\/index\.js";/);
    assert.match(registered, /features:\s*\[billingFeature\]/);
    assert.match(registered, /Keep this app note/);
    assert.equal(updateAppRegistrationSource(registered, {
      symbol: "billingFeature",
      module: "./features/billing/index.js",
    }), registered);
  });

  it("preserves trailing commas in multiline feature and app registrations", () => {
    const feature = updateFeatureRegistrationSource([
      'import { defineFeature } from "typescript-on-rails";',
      "",
      "export const statusFeature = defineFeature({",
      '  name: "status",',
      "  tests: [\"test/status.test.ts\"],",
      "});",
      "",
    ].join("\n"), {
      feature: "status",
      symbol: "Note",
      module: "./note.js",
      collection: "models",
    });
    assert.match(feature, /tests: \["test\/status\.test\.ts"\], models: \[Note\],/);
    assert.doesNotMatch(feature, /,,/);

    const app = updateAppRegistrationSource([
      'import { defineApp } from "typescript-on-rails";',
      "",
      "export const application = defineApp({",
      "  entrypoints: {},",
      "});",
      "",
    ].join("\n"), {
      symbol: "statusFeature",
      module: "./features/status/index.js",
    });
    assert.match(app, /entrypoints: \{\}, features: \[statusFeature\],/);
    assert.doesNotMatch(app, /,,/);
  });

  it("refuses noncanonical or ambiguous registration shapes", () => {
    assert.throws(
      () => updateFeatureRegistrationSource('export const billingFeature = makeFeature("billing");\n', {
        feature: "billing",
        symbol: "Invoice",
        module: "./invoice.js",
        collection: "models",
      }),
      /FEATURE_REGISTRATION_SHAPE_AMBIGUOUS/,
    );
    assert.throws(
      () => updateAppRegistrationSource('const features = []; export default defineApp({ features });\n', {
        symbol: "billingFeature",
        module: "./features/billing/index.js",
      }),
      /APP_REGISTRATION_SHAPE_AMBIGUOUS/,
    );
    assert.throws(
      () => updateAppRegistrationSource('defineApp({}); defineApp({});\n', {
        symbol: "billingFeature",
        module: "./features/billing/index.js",
      }),
      /APP_REGISTRATION_SHAPE_AMBIGUOUS/,
    );
    assert.throws(
      () => updateAppRegistrationSource('const billingFeature = {}; export default defineApp({ features: [] });\n', {
        symbol: "billingFeature",
        module: "./features/billing/index.js",
      }),
      /APPLICATION_SHAPE_SYMBOL_CONFLICT/,
    );
    assert.throws(
      () => updateAppRegistrationSource('export default defineApp({ ...base, features: [] });\n', {
        symbol: "billingFeature",
        module: "./features/billing/index.js",
      }),
      /APP_REGISTRATION_SHAPE_AMBIGUOUS/,
    );
    assert.throws(
      () => updateFeatureRegistrationSource('export const billingFeature = defineFeature({ ...base, name: "billing" });\n', {
        feature: "billing",
        symbol: "Invoice",
        module: "./invoice.js",
        collection: "models",
      }),
      /FEATURE_REGISTRATION_SHAPE_AMBIGUOUS/,
    );
    assert.throws(
      () => updateFeatureRegistrationSource('export const billingFeature = defineFeature({ name: "billing", models: [...baseModels] });\n', {
        feature: "billing",
        symbol: "Invoice",
        module: "./invoice.js",
        collection: "models",
      }),
      /FEATURE_REGISTRATION_SHAPE_AMBIGUOUS/,
    );
  });
});

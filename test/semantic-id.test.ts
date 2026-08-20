import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decodeSemanticId,
  encodeSemanticId,
  type SemanticId,
} from "../src/index.js";

describe("semantic ID codec", () => {
  it("encodes and decodes canonical UTF-8 IDs without normalization", () => {
    const operation: SemanticId = {
      category: "operation",
      owner: { kind: "feature", name: "réports/100%" },
      localName: "list invoices",
    };
    const contract: SemanticId = {
      category: "adapter-contract",
      owner: { kind: "infra", name: "_" },
      localName: "%",
    };
    const feature: SemanticId = {
      category: "feature",
      owner: { kind: "app", name: "_" },
      localName: "🚂",
    };
    const event: SemanticId = {
      category: "event",
      owner: { kind: "feature", name: "réports" },
      localName: "%only%",
    };
    const byteOrderMark: SemanticId = {
      category: "model",
      owner: { kind: "feature", name: "billing" },
      localName: "\uFEFFname",
    };
    const whitespace: SemanticId = {
      category: "route",
      owner: { kind: "feature", name: " " },
      localName: "\t",
    };

    const cases: readonly (readonly [SemanticId, string])[] = [
      [operation, "sid1/operation/feature/r%C3%A9ports%2F100%25/list%20invoices"],
      [contract, "sid1/adapter-contract/infra/_/%25"],
      [feature, "sid1/feature/app/_/%F0%9F%9A%82"],
      [event, "sid1/event/feature/re%CC%81ports/%25only%25"],
      [byteOrderMark, "sid1/model/feature/billing/%EF%BB%BFname"],
      [whitespace, "sid1/route/feature/%20/%09"],
    ];

    for (const [value, expected] of cases) {
      const encoded = encodeSemanticId(value);
      assert.equal(encoded, expected);
      assert.deepEqual(decodeSemanticId(encoded), value);
      assert.equal(encodeSemanticId(decodeSemanticId(encoded)), encoded);
    }
  });

  it("rejects malformed and noncanonical encoded IDs", () => {
    for (const invalid of [
      "sid1/operation/feature/billing/%2f",
      "sid1/operation/feature/billing/%41",
      "sid1/operation/infra/billing/list",
      "sid1/operation/app/billing/list",
      "sid1/operation/feature/_/list",
      "sid1/nope/feature/billing/list",
      "sid1/operation/nope/billing/list",
      "sid2/operation/feature/billing/list",
      "sid1/operation/feature/billing",
      "sid1/operation/feature/billing/list/extra",
      "sid1/operation/feature//list",
      "sid1/operation/feature/billing/",
      "sid1/operation/feature/billing/%",
      "sid1/operation/feature/billing/%0",
      "sid1/operation/feature/billing/%GG",
      "sid1/operation/feature/billing/a b",
      "sid1/operation/feature/billing/é",
      "sid1/operation/feature/billing/%FF",
      "sid1/operation/feature/billing/%C0%AF",
      "sid1/operation/feature/billing/%ED%A0%80",
    ]) {
      assert.throws(() => decodeSemanticId(invalid), invalid);
    }
  });

  it("rejects invalid owners, empty names, and every lone-surrogate position", () => {
    const finalHighSurrogate = `name${String.fromCharCode(0xd800)}`;
    const initialLowSurrogate = `${String.fromCharCode(0xdc00)}name`;
    const interruptedPair = `${String.fromCharCode(0xd800)}name`;

    for (const value of [
      {
        category: "operation",
        owner: { kind: "feature", name: "_" },
        localName: "list",
      },
      {
        category: "operation",
        owner: { kind: "infra", name: "billing" },
        localName: "list",
      },
      {
        category: "operation",
        owner: { kind: "feature", name: "" },
        localName: "list",
      },
      {
        category: "operation",
        owner: { kind: "feature", name: "billing" },
        localName: "",
      },
      {
        category: "operation",
        owner: { kind: "feature", name: finalHighSurrogate },
        localName: "list",
      },
      {
        category: "operation",
        owner: { kind: "feature", name: "billing" },
        localName: initialLowSurrogate,
      },
      {
        category: "operation",
        owner: { kind: "feature", name: interruptedPair },
        localName: "list",
      },
    ] satisfies readonly SemanticId[]) {
      assert.throws(() => encodeSemanticId(value));
    }
  });
});

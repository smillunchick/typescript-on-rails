import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  InvalidInput,
  array,
  boolean,
  date,
  enumOf,
  id,
  literal,
  money,
  number,
  object,
  optional,
  string,
  type Infer,
} from "../src/index.js";

describe("schemas", () => {
  it("validates and types a nested object", () => {
    const Person = object({
      id: id("Person"),
      name: string(),
      age: number(),
      active: boolean(),
      birthday: date(),
      balance: money(),
      role: enumOf("admin", "member"),
      label: literal("person"),
      nickname: optional(string()),
      tags: array(string()),
    });

    type Person = Infer<typeof Person>;
    const person: Person = Person.parse({
      id: "person_1",
      name: "Ada",
      age: 36,
      active: true,
      birthday: new Date("1990-01-01T00:00:00.000Z"),
      balance: 1250,
      role: "admin",
      label: "person",
      tags: ["founder"],
      ignored: "not returned",
    });

    assert.equal(person.name, "Ada");
    assert.equal(person.nickname, undefined);
    assert.deepEqual(Object.keys(person).sort(), [
      "active",
      "age",
      "balance",
      "birthday",
      "id",
      "label",
      "name",
      "nickname",
      "role",
      "tags",
    ]);
  });

  it("returns path-aware issues for all invalid nested fields", () => {
    const Input = object({
      customer: object({ name: string() }),
      totals: array(money()),
    });

    assert.throws(
      () => Input.parse({ customer: { name: 42 }, totals: [10, -1, "bad"] }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInput);
        assert.deepEqual(
          error.issues.map((issue) => issue.path),
          [["customer", "name"], ["totals", 1], ["totals", 2]],
        );
        return true;
      },
    );
  });

  it("retains JSON-serializable metadata", () => {
    const schema = object({ status: enumOf("open", "closed"), ownerId: id("User") });
    assert.doesNotThrow(() => JSON.stringify(schema.metadata));
    assert.deepEqual(schema.metadata, {
      kind: "object",
      fields: {
        status: { kind: "enum", values: ["open", "closed"] },
        ownerId: { kind: "id", entity: "User" },
      },
    });
  });

  it("rejects non-finite numbers, invalid dates, and blank ids", () => {
    assert.throws(() => number().parse(Number.POSITIVE_INFINITY), InvalidInput);
    assert.throws(() => date().parse(new Date("invalid")), InvalidInput);
    assert.throws(() => id().parse(""), InvalidInput);
  });
});

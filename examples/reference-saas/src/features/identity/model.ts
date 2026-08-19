import { defineModel, enumOf, id, string, type ObjectOutput } from "typescript-on-rails";

const userFields = {
  id: id("User"),
  customerId: id("Customer"),
  email: string(),
  role: enumOf("member", "admin"),
};

export type UserRecord = ObjectOutput<typeof userFields>;
export type UserId = UserRecord["id"];
export type CustomerId = UserRecord["customerId"];

export const User = defineModel({
  name: "User",
  fields: userFields,
});

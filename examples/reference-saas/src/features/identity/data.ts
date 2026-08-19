import { User, type UserRecord } from "./model.js";

const users: readonly UserRecord[] = [
  User.parse({
    id: "user_1",
    customerId: "customer_1",
    email: "owner@example.com",
    role: "admin",
  }),
  User.parse({
    id: "user_2",
    customerId: "customer_2",
    email: "member@example.com",
    role: "member",
  }),
];

export function findUserForCustomer(userId: string, customerId: string): UserRecord | null {
  return users.find((user) => user.id === userId && user.customerId === customerId) ?? null;
}

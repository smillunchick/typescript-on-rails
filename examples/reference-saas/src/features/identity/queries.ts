import { object, query } from "typescript-on-rails";

import { User, type UserRecord } from "./model.js";

const currentUser: UserRecord = User.parse({
  id: "user_1",
  email: "owner@example.com",
  role: "admin",
});

export const getCurrentUser = query({
  input: object({}),
  permission: "user.read",
  run: () => currentUser,
});

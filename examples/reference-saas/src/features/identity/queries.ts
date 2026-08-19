import { NotFound, object, query } from "typescript-on-rails";

import type { AuthenticatedContext } from "./context.js";
import { findUserForCustomer } from "./data.js";

export const getCurrentUser = query({
  input: object({}),
  permission: "user.read",
  run: (_input, context: AuthenticatedContext) => {
    const user = findUserForCustomer(context.userId, context.customerId);
    if (user === null) throw new NotFound();
    return user;
  },
});

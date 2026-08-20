# Agent-Native TypeScript Application Architecture Vision
## High-Level Architectural Plan

## Current shipped scope

The shipped product is an application architecture kernel and compiler with runtime contract primitives. It provides architecture analysis, strict TypeScript conventions, application structure, generators, and introspection.

It does not provide HTTP serving, rendered UI, persistence or storage, or bundling. Applications own those runtime layers and their development, build, and test scripts. No-emit TypeScript checks are not application builds.

This document also describes a long-term architecture framework vision. HTTP, UI, persistence, storage, and bundling discussed below are future directions, not features of the shipped package.

## 1. Premise

Explore a long-term full-stack TypeScript architecture framework designed around one unusually strict idea:

> **The easiest way to build an application should also be the correct way to build it.**

The framework should make well-structured, legible, maintainable software the default outcome rather than something that depends on the taste and discipline of each developer or coding agent.

It should take inspiration from the best qualities of Ruby on Rails:

- convention over configuration
- strong defaults
- a small number of concepts
- predictable project structure
- high developer velocity
- readable application code
- an obvious “Rails way” to do common things

But it should be designed specifically for the reality of software development with coding agents.

The goal is not merely to make TypeScript development faster.

The goal is to create a **software environment whose architecture is inherently understandable to both humans and agents**.

---

# 2. Core Design Thesis

Most modern frameworks optimize primarily for one or more of:

- flexibility
- runtime performance
- developer ergonomics
- ecosystem compatibility
- deployment convenience

This framework should optimize for something broader:

> **Long-term codebase coherence.**

A good codebase should remain easy to understand after:

- 10 developers
- 20 agents
- 500 features
- thousands of automated edits
- years of accumulated changes

The framework should therefore aggressively reduce the number of architectural decisions that application developers need to make.

Where there is a known good pattern, the framework should choose it.

Where variation is genuinely necessary, the framework should expose a clear seam.

---

# 3. The Core Principles

## 3.1 Simplicity is the primary constraint

Complexity must justify itself.

The framework should prefer:

- explicit code over clever code
- direct calls over indirection
- concrete modules over abstraction layers
- obvious data flow over magical behavior
- a few strong primitives over many specialized primitives

A developer should be able to open an unfamiliar feature and understand its shape almost immediately.

The framework itself may contain sophisticated machinery internally.

Application code should not.

---

## 3.2 Code is the source of truth

There should not be a second architectural truth living in documentation.

The application itself should express:

- what features exist
- what each feature owns
- what its public interface is
- what data it owns
- what actions it permits
- what invariants it enforces
- what external systems it depends on
- what permissions it requires
- what events it emits
- what other modules may call it

Documentation should therefore be **generated from code**, not separately maintained.

A coding agent should be able to enter the repository, inspect the code structure, and reconstruct how the system works without reading a giant `ARCHITECTURE.md`.

Documentation becomes a projection of the system rather than another system that can drift out of sync.

---

## 3.3 Deep modules, narrow interfaces

The framework should strongly encourage deep modules.

A feature may contain substantial internal complexity while exposing only a small public surface.

For example:

```text
billing/
├── index.ts
├── model.ts
├── actions.ts
├── queries.ts
├── schema.ts
├── ui/
└── tests/
```

Other features should not import arbitrary internals.

They import from:

```ts
import { createInvoice, getInvoice } from "@/features/billing";
```

not:

```ts
import { calculateTax } from "@/features/billing/internal/tax/calculator";
```

The framework should enforce this mechanically.

The principle is:

> **Large interiors. Small doors.**

This reduces coupling, makes refactoring safer, and dramatically reduces the amount of context an agent must understand before changing a feature.

---

## 3.4 Seams exist where change is real

The framework should distinguish between a useful seam and premature abstraction.

A seam should normally exist when:

- an external system is involved
- implementations genuinely vary
- infrastructure may change
- testing requires substitution
- a domain boundary exists
- a dependency is owned by another feature

Examples:

```text
payments → StripeAdapter
email → MailAdapter
storage → ObjectStorage
identity → AuthProvider
```

But the framework should discourage interfaces created merely because “we might need another implementation someday.”

The rule:

> **Abstract around actual boundaries, not imagined futures.**

---

## 3.5 Boring TypeScript

TypeScript should be treated as a tool for clarity rather than a playground for type-system cleverness.

Application code should generally avoid:

- deeply recursive types
- conditional-type puzzles
- excessive generic parameters
- complex mapped types
- `as` casting to silence the compiler
- non-null assertions used casually
- broad `any`
- giant union machines
- barrel-file dependency mazes
- decorator magic
- hidden dependency injection
- dynamic module resolution
- implicit global state

Advanced TypeScript may exist inside framework internals.

It should rarely be necessary in application code.

A good rule:

> **If understanding the type is harder than understanding the runtime behavior, the abstraction has probably failed.**

---

# 4. The Fundamental Unit: The Feature

The central organizational primitive should be the **feature**, not the technical layer.

Instead of:

```text
controllers/
services/
models/
repositories/
components/
hooks/
utils/
```

the codebase should look more like:

```text
features/
├── accounts/
├── billing/
├── onboarding/
├── reports/
└── teams/
```

Each feature contains the code necessary to implement that capability.

For example:

```text
features/
└── billing/
    ├── index.ts
    ├── model.ts
    ├── schema.ts
    ├── actions.ts
    ├── queries.ts
    ├── events.ts
    ├── policy.ts
    ├── ui/
    │   ├── invoice-list.tsx
    │   └── invoice-page.tsx
    └── billing.test.ts
```

Not every file must exist.

The framework should avoid empty ceremony.

A simple feature might contain only:

```text
features/
└── profile/
    ├── index.ts
    ├── actions.ts
    └── profile-page.tsx
```

Complexity appears only when the feature actually requires it.

---

# 5. The Public Boundary

Every feature should have exactly one obvious public boundary.

For example:

```ts
// features/billing/index.ts

export { createInvoice } from "./actions";
export { getInvoice, listInvoices } from "./queries";

export type {
  Invoice,
  InvoiceId
} from "./model";
```

Everything not exported from this file is considered private.

The framework tooling should prevent other modules from bypassing this boundary.

This gives humans and agents a trivial discovery mechanism:

> Want to know what Billing can do? Read `features/billing/index.ts`.

That one convention creates enormous architectural leverage.

---

# 6. Long-Term Full-Stack Vision

A future architecture framework should allow a feature to span the complete application stack.

For example, `projects` may own:

- database schema
- domain rules
- queries
- mutations
- HTTP/API exposure
- server actions
- authorization
- frontend components
- routes
- validation
- events
- tests

The important boundary is the **product capability**, not whether code runs in a browser or server.

Runtime boundaries should still be explicit.

For example:

```ts
import { server } from "framework/runtime";

export const createProject = server.action(...)
```

or:

```ts
import { client } from "framework/runtime";

export const ProjectEditor = client.component(...)
```

The developer should never have to guess where code executes.

---

# 7. Declarative Domain Contracts

The framework should provide a small mechanism for describing important domain behavior directly in executable code.

For example:

```ts
export const Invoice = defineModel({
  name: "Invoice",

  fields: {
    id: id(),
    customerId: id("Customer"),
    status: enumOf("draft", "issued", "paid"),
    total: money()
  },

  invariants: [
    invariant(
      "paid invoices cannot be edited",
      invoice => invoice.status !== "paid" || invoice.isImmutable
    )
  ]
});
```

This serves several purposes simultaneously:

- runtime behavior
- type inference
- validation
- introspection
- generated documentation
- agent understanding
- test generation where useful
- database tooling

The intent is not to create a giant DSL.

The framework should keep these declarations close to normal TypeScript.

---

# 8. Actions and Queries

The framework should make data-changing operations highly visible.

For example:

```ts
export const approveInvoice = action({
  input: {
    invoiceId: Invoice.id
  },

  authorize: ({ user }) => user.can("invoice.approve"),

  run: async ({ invoiceId }) => {
    const invoice = await Invoice.get(invoiceId);

    invoice.approve();

    await Invoice.save(invoice);
  }
});
```

Reads should be similarly explicit:

```ts
export const getInvoice = query({
  input: {
    invoiceId: Invoice.id
  },

  run: ({ invoiceId }) => {
    return Invoice.get(invoiceId);
  }
});
```

This creates an immediately traversable architecture.

An agent can determine:

- what operations exist
- what arguments they accept
- whether they mutate state
- what authorization applies
- what data they touch

without hunting through arbitrary utility functions.

---

# 9. Data Ownership

Every persistent data structure should have an obvious owner.

For example:

```text
Customer → customers
Invoice → billing
Subscription → billing
User → identity
Workspace → teams
```

Other features should generally access that data through the owning feature's public API.

Direct cross-feature database access should be prohibited or strongly discouraged.

Instead of:

```ts
db.invoice.findMany(...)
```

inside the reporting feature:

```ts
billing.listInvoices(...)
```

This protects module boundaries and prevents the database schema from becoming the de facto architecture of the application.

---

# 10. Dependencies Must Point in Understandable Directions

The framework should maintain an explicit feature dependency graph.

For example:

```text
checkout
 ├── billing
 ├── catalog
 └── identity

billing
 └── payments

payments
 └── StripeAdapter
```

Circular feature dependencies should be forbidden.

The framework CLI should be able to answer:

```bash
app graph
```

and produce the actual dependency graph from code.

No manually maintained diagram should be necessary.

---

# 11. Architecture as a Compiler Constraint

Architectural rules should not merely appear in a style guide.

They should be mechanically enforced.

Examples:

- features cannot import private files from another feature
- browser code cannot import server-only modules
- infrastructure adapters cannot leak vendor types into domain code
- domain modules cannot directly depend on UI code
- circular dependencies are rejected
- database access must occur through approved ownership boundaries
- forbidden TypeScript constructs trigger errors
- unsafe casts require explicit justification
- public APIs must be typed
- external IO must cross a declared seam

Ideally, architectural violations should fail during development rather than appear six months later in a code review.

---

# 12. Escape Hatches

Absolute rigidity eventually creates absurdity.

The framework therefore needs escape hatches.

But escape hatches should be:

1. explicit
2. local
3. searchable
4. explainable

For example:

```ts
architecture.allow({
  rule: "cross-feature-import",
  reason: "Temporary migration from legacy billing module",
  expires: "2026-12-01"
});
```

An agent can immediately tell that something unusual is deliberate rather than accidental.

The CLI could expose:

```bash
app exceptions
```

to show every architectural exception in the application.

This leads to an important principle:

> **It should be difficult to do the wrong thing invisibly.**

---

# 13. Testing Philosophy

The framework should explicitly reject “tests for tests' sake.”

Tests exist to protect meaningful behavior.

The preferred hierarchy should be:

### 1. Type system

Catch structural mistakes at compile time.

### 2. Framework invariants

Catch architectural violations automatically.

### 3. Domain tests

Test meaningful business rules.

### 4. Integration tests

Test important interactions between real boundaries.

### 5. End-to-end tests

Protect the small number of flows whose failure would materially hurt users or the business.

The framework should discourage:

- trivial getter tests
- snapshots of implementation noise
- tests of framework behavior
- mocking every dependency
- tests tightly coupled to internal implementation

A feature's tests should largely describe its **promises**.

Example:

```ts
describe("invoice approval", () => {
  it("cannot approve an invoice with no line items", ...);

  it("records who approved the invoice", ...);

  it("cannot modify an invoice after payment", ...);
});
```

These are useful to both humans and agents because they communicate domain expectations.

---

# 14. Generated Understanding Instead of Written Documentation

Because the code is structured and introspectable, the framework should be able to generate views of the application.

For example:

```bash
app explain billing
```

might output:

```text
Billing

Owns:
- Invoice
- Subscription

Public actions:
- createInvoice
- approveInvoice
- cancelSubscription

Public queries:
- getInvoice
- listInvoices
- getSubscription

Depends on:
- identity
- payments

External systems:
- Stripe

Permissions:
- invoice.read
- invoice.approve
- subscription.cancel

Emits:
- InvoiceCreated
- InvoicePaid
- SubscriptionCancelled
```

This information should be derived from the codebase.

Not maintained separately.

The same underlying introspection could generate:

- architecture diagrams
- API references
- agent context
- dependency graphs
- onboarding views
- security inventories
- database ownership maps

---

# 15. Agent-Native Architecture

Agent support should not mean sprinkling AI features onto the CLI.

The architecture itself should make agent reasoning cheap and reliable.

A coding agent entering a feature should quickly answer:

1. What does this feature own?
2. What can it do?
3. What may call it?
4. What does it depend on?
5. What invariants must remain true?
6. What external systems does it touch?
7. What tests describe its promises?
8. Where can I safely make this change?

The framework should optimize repository structure for these questions.

---

# 16. Context Locality

Agent performance deteriorates when understanding one behavior requires reading dozens of unrelated files.

The framework should therefore optimize for **context locality**.

Most changes to a feature should be achievable by loading:

```text
features/foo/
```

plus the public interfaces of its dependencies.

An agent should not ordinarily need the entire repository in context.

Deep modules and explicit public boundaries make this possible.

This may eventually become a measurable framework property:

> **How much code must be read before a change can be made safely?**

Call this the **context radius**.

Keeping context radius low should be a first-class architectural goal.

---

# 17. Framework Introspection API

The framework should expose its architecture programmatically.

For example:

```ts
app.features()
app.dependencies()
app.actions()
app.queries()
app.models()
app.permissions()
app.events()
app.adapters()
```

This would allow agents and developer tools to query the system directly instead of reconstructing architecture through grep.

Eventually an agent protocol could expose commands such as:

```text
describe_feature("billing")
find_owner("Invoice")
find_callers("approveInvoice")
show_dependencies("checkout")
explain_route("/invoices/:id")
```

The key distinction is that this information comes from the application architecture itself.

It is not manually written AI documentation.

---

# 18. CLI as the Primary Interface

Rails succeeded partly because its command-line experience made the framework's worldview tangible.

This framework should have a similarly small CLI.

Potential commands:

```bash
app new
app dev
app build
app check
app test

app create feature billing
app create model Invoice
app create action approveInvoice

app explain billing
app graph
app owners
app boundaries
app exceptions
```

In the shipped kernel, `app check` performs architecture checks. `app dev`, `app build`, and `app test` only delegate to matching app-owned scripts; the kernel does not supply those lifecycles.

Avoid dozens of generators.

Generators should create the minimum useful structure rather than boilerplate mountains.

---

# 19. The `app check` Command

One command should answer:

> Is this codebase healthy?

```bash
app check
```

It might run:

- TypeScript validation
- architecture rules
- linting
- dependency analysis
- schema validation
- permission validation
- dead export detection
- tests relevant to changed features
- external-boundary checks

The result should be concise.

For agents this is particularly powerful.

Instead of remembering fifteen project-specific verification commands, an agent needs one:

```bash
app check
```

---

# 20. Frontend Philosophy

The frontend should follow the same simplicity rules.

Avoid forcing developers into elaborate state-management architectures.

Prefer:

- server state on the server
- URL state in URLs
- form state in forms
- local interaction state in components
- shared client state only when truly necessary

Feature UI lives with the feature.

For example:

```text
billing/
├── ui/
│   ├── invoice-page.tsx
│   ├── invoice-table.tsx
│   └── payment-status.tsx
```

Shared primitives belong in a deliberately small shared UI layer:

```text
ui/
├── button.tsx
├── dialog.tsx
├── input.tsx
└── table.tsx
```

The framework should resist the tendency for `components/` to become an unstructured landfill.

---

# 21. Backend Philosophy

Backend code should similarly avoid ceremonial layering.

Do not automatically require:

```text
Controller
→ Service
→ Repository
→ ORM
→ Database
```

when:

```text
Action
→ Model
→ Database
```

would be clearer.

Layers should exist because they create a meaningful boundary, not because an architecture diagram says every application needs them.

---

# 22. Infrastructure Adapters

External technologies should sit behind standardized seams.

For example:

```text
infra/
├── email/
├── payments/
├── storage/
├── search/
├── cache/
├── jobs/
└── analytics/
```

An application may choose implementations:

```ts
export default defineApp({
  email: ResendEmail(),
  payments: StripePayments(),
  storage: S3Storage()
});
```

The framework owns the abstract capability.

An adapter owns vendor-specific behavior.

This allows the framework to interface with the wider ecosystem without making the core architecture dependent on particular vendors.

---

# 23. Database Strategy

The framework should probably avoid inventing a database.

Instead it should define a consistent persistence contract over established technology.

Important goals:

- typed schemas
- migrations
- transactions
- explicit ownership
- predictable queries
- easy local development
- no hidden N+1 behavior
- production-safe defaults

PostgreSQL would be a sensible default target.

The framework could initially build over an existing TypeScript database layer rather than inventing its own ORM.

The framework's innovation should be the architecture around data, not novelty for novelty's sake.

---

# 24. Performance by Default

“Performant by definition” cannot literally mean every application is automatically fast.

Business logic can always be inefficient.

But the framework can make common performance mistakes difficult.

Defaults should encourage:

- server rendering where appropriate
- streaming where useful
- minimal browser JavaScript
- code splitting
- database query visibility
- bounded query patterns
- explicit caching
- no accidental waterfalls
- request-scoped data reuse
- observable slow operations

Performance problems should be visible.

For example:

```bash
app check
```

might flag:

```text
Billing.invoiceList

Potential unbounded query.
Route: /invoices
Query: Invoice.list()
Suggestion: declare pagination or explicit maximum.
```

Again: wrong behavior should be hard to introduce silently.

---

# 25. Security by Construction

The same philosophy can apply to security.

Actions that access protected resources should declare authorization.

For example:

```ts
export const deleteProject = action({
  permission: "project.delete",
  ...
});
```

The framework should make it difficult to accidentally expose a mutation without an authorization decision.

Other useful defaults:

- safe serialization
- CSRF protection
- input validation
- output escaping
- secrets isolation
- dependency auditing
- explicit server/client boundaries
- secure cookie defaults

Security should be part of normal framework semantics rather than an optional checklist.

---

# 26. Error Handling

The framework should establish a small, consistent error model.

For example:

```ts
NotFound
Unauthorized
Forbidden
InvalidInput
Conflict
Unavailable
Unexpected
```

Features may add domain-specific errors where useful.

Errors should propagate predictably across:

```text
domain
→ server
→ HTTP
→ UI
```

An agent should not need to reverse engineer a different error philosophy in every feature.

---

# 27. Events

Features should communicate asynchronously through explicit events where appropriate.

Example:

```ts
export const InvoicePaid = event({
  invoiceId: Invoice.id,
  customerId: Customer.id,
  amount: money()
});
```

Consumers declare subscriptions:

```ts
on(InvoicePaid, sendReceipt);
```

The dependency graph should understand these relationships.

Events should not become a universal solution.

Direct calls remain preferable when direct calls are clearer.

---

# 28. Shared Code Should Be Suspicious

A common failure mode is the growth of:

```text
utils/
helpers/
common/
shared/
```

These become architectural junk drawers.

The framework should encourage code to remain owned by a feature until there is clear evidence that it represents a genuine reusable concept.

A useful heuristic:

> Duplication is often cheaper than the wrong abstraction.

Extraction should happen after a stable shared concept becomes visible.

---

# 29. Naming Is Architecture

Because the code must be readable by humans and agents, naming quality matters unusually strongly.

The framework should encourage:

```ts
approveInvoice()
```

rather than:

```ts
process()
handle()
execute()
runTask()
doThing()
```

Names should describe domain behavior.

An application's vocabulary should match the vocabulary of the business.

The source tree should read almost like a map of the product.

---

# 30. Minimal Magic

Rails demonstrates that some magic can produce extraordinary ergonomics.

But magic has a higher cost in an agent-heavy environment because hidden behavior makes reasoning harder.

The framework should therefore prefer:

> **Convenient conventions with inspectable mechanics.**

If the framework infers something, the developer should be able to ask:

```bash
app explain route /invoices/123
```

and see exactly why that route behaves as it does.

Magic must be explainable.

---

# 31. Determinism Matters for Agents

Given the same request, two competent coding agents should tend to produce structurally similar implementations.

That requires the framework to constrain arbitrary choices.

For example, an agent should not have to decide:

- where validation belongs
- where authorization belongs
- how database access is structured
- where feature UI lives
- where an external integration belongs
- how errors propagate
- where tests go
- how feature dependencies are declared

The framework already has answers.

The agent spends its intelligence on the product problem instead.

---

# 32. Progressive Complexity

The framework should have a very low conceptual floor while preserving a high ceiling.

A small application might look like:

```text
app/
├── features/
│   ├── todos/
│   └── users/
└── app.ts
```

The same architecture should remain valid as the system grows.

New concepts should appear only when necessary:

```text
events
jobs
adapters
policies
caches
workflows
```

This prevents developers from paying enterprise-complexity costs before they have enterprise problems.

---

# 33. What the Framework Should Not Become

It should not become:

### A giant DSL

Application code should still look like TypeScript.

### A code generator

Generated code is useful only where it reduces meaningful work.

### An AI wrapper

Agent-native architecture is deeper than adding `ai` commands.

### A universal abstraction layer

The framework should integrate with ecosystems rather than pretending differences between systems do not exist.

### Enterprise Java in TypeScript clothing

Avoid mandatory interfaces, repositories, dependency injection containers, factories, and service classes when direct code is clearer.

### A linter marketed as a framework

Architectural enforcement matters, but the framework must provide a cohesive application model.

---

# 34. Possible Technical Shape

The first implementation could itself be a relatively thin layer over proven infrastructure.

For example:

```text
Language
└── TypeScript

Runtime
├── Node.js
└── potentially Bun later

UI
└── React

Database
└── PostgreSQL

Build system
└── existing modern bundler

Validation
└── framework-owned schema API or thin wrapper

Testing
└── existing test runner

Framework
├── project structure
├── feature model
├── routing
├── server actions
├── queries
├── architecture compiler
├── adapters
├── authorization
├── introspection
└── CLI
```

The framework should initially reuse mature runtime components wherever they are not the source of the architectural problem.

Do not reinvent PostgreSQL, React, HTTP, bundlers, or test runners simply to claim a completely proprietary stack.

---

# 35. The Architecture Compiler

Potentially the most differentiated component is an **architecture compiler**.

It understands the semantic structure of the application rather than merely compiling TypeScript.

It knows:

- features
- ownership
- public APIs
- runtime boundaries
- permissions
- actions
- queries
- events
- models
- dependencies
- adapters

This enables enforcement and introspection.

For example:

```text
src/features/reports/actions/export.ts
```

attempting to import:

```text
src/features/billing/schema.ts
```

could fail with:

```text
ArchitectureError

reports cannot import a private module from billing.

Use the billing public interface:

  import { ... } from "@/features/billing"

or expose the required capability through:

  features/billing/index.ts
```

This is more useful than a generic lint error because the framework understands architectural intent.

---

# 36. Agent Workflow

A coding agent working inside this framework might follow a deterministic loop.

### Understand

```bash
app explain feature invoices
```

### Inspect impact

```bash
app impact invoice.approve
```

### Implement

Change the local feature.

### Verify

```bash
app check
```

### Understand the resulting architecture

```bash
app diff --architecture
```

That final command might output:

```text
Architecture changes

billing
+ public action: refundInvoice
+ dependency: payments.refund

Permissions
+ invoice.refund

Events
+ InvoiceRefunded
```

That is far more useful to an agent than an unstructured Git diff alone.

---

# 37. Architectural Diffing

This could become another distinctive capability.

Normal version control tells us:

```text
18 files changed
342 insertions
91 deletions
```

The framework could additionally tell us:

```text
Architecture

Feature created:
- refunds

Public API changed:
- billing.refundInvoice added

Dependency created:
- refunds → payments

Data ownership:
- Refund now owned by refunds

Permission added:
- refund.create
```

For human reviewers and coding agents alike, this provides a semantic representation of a change.

---

# 38. Framework Doctrine

The project should probably have a short doctrine against which every design decision is evaluated.

A tentative version:

1. **Simplicity wins.**
2. **Code is truth.**
3. **Features own behavior.**
4. **Modules are deep; interfaces are narrow.**
5. **Boundaries are explicit.**
6. **Seams exist where reality changes.**
7. **TypeScript stays boring.**
8. **Tests protect promises, not implementation.**
9. **Architecture is enforced, not documented.**
10. **Complexity must earn its existence.**
11. **Agents and humans should see the same system.**
12. **Wrong decisions should be difficult to make invisibly.**

These should remain unusually stable.

Framework features that violate them should face a very high bar.

---

# 39. Long-Term Product Scope

A future full-stack version should not attempt to solve every category of software.

A sensible future target would be:

> **Full-stack database-backed web applications and SaaS products.**

This covers a huge amount of real software while keeping the problem tractable.

Version one could support:

- TypeScript
- React
- Node
- PostgreSQL
- HTTP
- server-rendered pages
- client interactivity
- authentication
- authorization
- forms
- actions
- queries
- jobs
- external adapters
- testing
- deployment adapters

Other targets could come later.

---

# 40. Development Sequence

## Phase 1 — Doctrine

Define the architectural rules before writing the framework.

Produce a short set of non-negotiable principles.

The most important design work happens here.

---

## Phase 2 — Reference Application

Build a realistic SaaS application manually according to the doctrine.

Do not build the framework yet.

Use the reference application to discover:

- repeated patterns
- painful decisions
- useful conventions
- genuine seams
- unnecessary abstractions

The framework should emerge from demonstrated patterns rather than theory.

---

## Phase 3 — Extract the Framework

Turn repeated architecture into framework primitives.

Likely first primitives:

```text
feature
model
action
query
policy
event
adapter
route
```

Keep the primitive count low.

---

## Phase 4 — Architecture Enforcement

Build the compiler/static-analysis layer that enforces:

- module boundaries
- ownership
- runtime separation
- dependency direction
- TypeScript profile
- public interfaces

---

## Phase 5 — Introspection

Add:

```bash
app explain
app graph
app owners
app impact
```

This is where the framework starts becoming deeply agent-native.

---

## Phase 6 — Agent Tooling

Expose framework introspection through a machine-readable protocol.

Agents should be able to query architecture directly.

---

## Phase 7 — Ecosystem

Add adapters for common systems:

- authentication
- PostgreSQL providers
- payments
- email
- object storage
- queues
- observability
- analytics
- deployment environments

---

# 41. The Standard for Success

The framework should ultimately pass a fairly brutal test.

Give a competent coding agent a substantial application built with the framework that it has never seen before.

Then ask it to:

> Add a new product capability that touches UI, backend logic, persistence, authorization, and an external service.

The agent should be able to determine the correct architecture largely from the codebase itself.

It should not need:

- a 40-page architecture guide
- tribal knowledge
- a repository-specific prompt
- five `AGENTS.md` files
- arbitrary developer conventions
- reverse engineering of accidental structure

And when the agent finishes:

```bash
app check
```

should be capable of detecting most architectural mistakes before the change is accepted.

If that works consistently, the framework has achieved something materially different from today's TypeScript frameworks.

---

# 42. The Larger Idea

The interesting part of this project is not really “a new TypeScript framework.”

It is a different answer to the question:

> **What should programming frameworks optimize for when a large percentage of code will be written and maintained by reasoning agents?**

Historically, frameworks acted partly as compressed institutional knowledge.

Rails encoded David Heinemeier Hansson's opinions about how web applications should be structured.

An agent-native framework can go further.

It can encode:

- architectural taste
- module discipline
- software-design principles
- security expectations
- performance expectations
- discoverability
- machine-readable intent

directly into the environment in which software is created.

The ambition is therefore:

> **A framework that makes good architecture the path of least resistance — for humans and agents alike.**

Or more aggressively:

> **A codebase whose structure teaches you how to extend it.**

import { Demo } from "./demo.client.js";

export default function Home() {
  return <main className="shell">
    <header className="intro">
      <h1>One stack, from request to durable work.</h1>
      <p>
        This reference joins Next and React rendering, an authenticated HTTP boundary,
        PostgreSQL-ready transactions, durable jobs, and a complete semantic architecture graph.
      </p>
    </header>
    <section className="flow" aria-labelledby="flow-heading">
      <div className="flow-copy">
        <h2 id="flow-heading">Run the complete local path</h2>
        <p>
          Sign in with the fixed local identity, then create a project. The request crosses session,
          authorization, operation, event, job, and email boundaries without production credentials.
        </p>
      </div>
      <Demo />
    </section>
  </main>;
}

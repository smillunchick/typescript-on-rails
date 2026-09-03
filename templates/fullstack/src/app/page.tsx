import { StatusCheck } from "./status-check.client.js";

export default function HomePage() {
  return (
    <main>
      <header className="masthead">
        <a className="wordmark" href="/">TypeScript on Rails</a>
        <span className="build-state">Architecture connected</span>
      </header>

      <section className="intro" aria-labelledby="page-title">
        <div>
          <h1 id="page-title">Your application is ready.</h1>
          <p>
            This starting point keeps application code, the executable graph,
            and framework checks aligned from the first feature.
          </p>
        </div>
        <StatusCheck />
      </section>

      <section className="path" aria-labelledby="path-title">
        <h2 id="path-title">One path from intent to runtime</h2>
        <ol role="list">
          <li><strong>Create a feature.</strong><span>The generator registers plain TypeScript in the application graph.</span></li>
          <li><strong>Define behavior.</strong><span>Operations state input, access, output, and execution together.</span></li>
          <li><strong>Run one check.</strong><span>Manifest v2, executable completeness, and runtime checks agree.</span></li>
        </ol>
      </section>
    </main>
  );
}

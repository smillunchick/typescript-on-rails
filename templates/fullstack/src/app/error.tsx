"use client";

export default function ErrorPage({ reset }: Readonly<{ reset: () => void }>) {
  return (
    <main className="message-page">
      <h1>The page could not load.</h1>
      <p>The application is still running. Retry this request.</p>
      <button type="button" onClick={reset}>Try again</button>
    </main>
  );
}

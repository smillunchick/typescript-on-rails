"use client";
export default function ErrorPage({ reset }: { readonly reset: () => void }) { return <main><h1>The reference app could not load</h1><button type="button" onClick={reset}>Try again</button></main>; }

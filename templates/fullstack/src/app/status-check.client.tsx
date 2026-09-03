"use client";

import { useState } from "react";

interface StatusResult {
  readonly status: string;
  readonly framework: string;
}

function isStatusResult(value: unknown): value is StatusResult {
  return typeof value === "object" && value !== null
    && "status" in value && typeof value.status === "string"
    && "framework" in value && typeof value.framework === "string";
}

export function StatusCheck() {
  const [result, setResult] = useState<StatusResult>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  async function check() {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      if (!response.ok) throw new Error(`Status request failed (${String(response.status)})`);
      const value: unknown = await response.json();
      if (!isStatusResult(value)) throw new Error("Status response was invalid");
      setResult(value);
    } catch (cause) {
      setResult(undefined);
      setError(cause instanceof Error ? cause.message : "Status request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="status-panel">
      <div aria-live="polite">
        <span className="status-dot" aria-hidden="true" />
        <strong>{result?.status === "ready" ? "Runtime responded" : "Local status route"}</strong>
        <p>{result === undefined ? "Verify the registered HTTP path without leaving this page." : `${result.framework} reports ${result.status}.`}</p>
        {error === undefined ? null : <p className="status-error">{error}. Try again after the development server is ready.</p>}
      </div>
      <button type="button" onClick={check} disabled={loading}>
        {loading ? "Checking…" : "Check connection"}
      </button>
    </div>
  );
}

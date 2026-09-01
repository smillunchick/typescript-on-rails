"use client";
import { useState } from "react";

function cookieValue(name: string): string | undefined {
  for (const entry of document.cookie.split(";")) {
    const [cookieName, ...parts] = entry.trim().split("=");
    if (cookieName === name) return decodeURIComponent(parts.join("="));
  }
  return undefined;
}

type Status = "idle" | "loading" | "success" | "error";

export function Demo() {
  const [message, setMessage] = useState("Sign in to create a project.");
  const [status, setStatus] = useState<Status>("idle");
  const [pending, setPending] = useState<"sign-in" | "project" | null>(null);
  const [signedIn, setSignedIn] = useState(false);
  const [interactions, setInteractions] = useState(0);

  async function signIn() {
    setPending("sign-in");
    setStatus("loading");
    setMessage("Signing in with the local identity…");
    try {
      const response = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: "demo", proof: "local-proof" }),
      });
      if (!response.ok) throw new Error("SIGN_IN_DENIED");
      setSignedIn(true);
      setStatus("success");
      setMessage("Signed in. The session and CSRF proofs are ready.");
    } catch {
      setSignedIn(false);
      setStatus("error");
      setMessage("Sign-in failed. Check the local server, then try again.");
    } finally {
      setPending(null);
    }
  }

  async function createProject() {
    const csrf = cookieValue("__Host-tor-csrf");
    if (csrf === undefined) {
      setStatus("error");
      setMessage("The CSRF proof is missing. Sign in again before creating a project.");
      return;
    }
    setPending("project");
    setStatus("loading");
    setMessage("Saving the project and queuing durable work…");
    try {
      const next = interactions + 1;
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrf },
        body: JSON.stringify({
          id: `project_${String(next)}`,
          name: `Reference project ${String(next)}`,
        }),
      });
      if (!response.ok) throw new Error("PROJECT_DENIED");
      setInteractions(next);
      setStatus("success");
      setMessage("Project saved. Durable welcome work is queued once.");
    } catch {
      setStatus("error");
      setMessage("Project creation failed safely. No successful result was claimed.");
    } finally {
      setPending(null);
    }
  }

  return <div className="demo">
    <p className="demo-status" role="status" aria-live="polite" data-state={status}>
      {message}
    </p>
    <div className="demo-actions">
      <button className="action secondary" type="button" onClick={signIn} disabled={pending !== null}>
        {pending === "sign-in" ? "Signing in…" : signedIn ? "Refresh local session" : "Sign in locally"}
      </button>
      <button className="action" type="button" onClick={createProject} disabled={!signedIn || pending !== null}>
        {pending === "project" ? "Creating project…" : "Create project"}
      </button>
    </div>
    <p className="demo-proof">Completed client interactions: {interactions}</p>
  </div>;
}

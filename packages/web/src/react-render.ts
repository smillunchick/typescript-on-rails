import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";

import { secureHeaders } from "./http.js";

export async function renderReact(
  node: ReactNode,
  options: {
    readonly status?: number;
    readonly nonce?: string;
    readonly bootstrapScripts?: readonly string[];
  } = {},
): Promise<Response> {
  if ((options.bootstrapScripts?.length ?? 0) > 0 && options.nonce === undefined) {
    throw new TypeError("REACT_BOOTSTRAP_NONCE_REQUIRED");
  }
  const body = await renderToReadableStream(node, {
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
    ...(options.bootstrapScripts === undefined
      ? {}
      : { bootstrapScripts: [...options.bootstrapScripts] }),
  });
  await body.allReady;
  return new Response(body, {
    status: options.status ?? 200,
    headers: {
      ...secureHeaders(options.nonce),
      "Content-Type": "text/html; charset=utf-8",
    },
  });
}

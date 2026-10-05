import { readFile } from "node:fs/promises";
import path from "node:path";

import { authenticatedVisitor, HttpError } from "./auth.ts";

// process.cwd(), not import.meta.url: this module runs bundled inside the
// Next server, where source-relative paths no longer point at the repository.
const prototypeFile = path.join(
  process.cwd(),
  "src/server/procurement-prototypes.html",
);

const privateResponse = "private, no-store";

export async function procurementPrototype(request: Request) {
  try {
    authenticatedVisitor(request);
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.status === 401 &&
      error.code === "DEMO_ACCESS_REQUIRED"
    )
      // Relative, because behind CloudFront request.url carries the origin
      // host rather than the public one.
      return new Response(null, {
        status: 303,
        headers: {
          Location: "/procurement-access",
          "Cache-Control": privateResponse,
        },
      });
    throw error;
  }
  return new Response(await readFile(prototypeFile), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": privateResponse,
    },
  });
}

import { enterDemo } from "../../../server/gate.ts";
import { handle } from "../../../server/http.ts";
import { visitorContext } from "../../../server/visitor.ts";

export function POST(request: Request) {
  return handle(() => enterDemo(request));
}
export function GET(request: Request) {
  return handle(() => visitorContext(request));
}

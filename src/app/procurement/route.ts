import { handle } from "../../server/http.ts";
import { procurementPrototype } from "../../server/procurement.ts";

export function GET(request: Request) {
  return handle(() => procurementPrototype(request));
}

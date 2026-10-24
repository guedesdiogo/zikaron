import { DurableObject } from "cloudflare:workers";

/** Hosts an index in tests: tests reach its storage through `runInDurableObject`. */
export class IndexHost extends DurableObject {}

export default {
  fetch: () => new Response(null, { status: 404 }),
};

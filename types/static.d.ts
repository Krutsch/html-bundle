declare module "critical";

declare module "httpolyglot" {
  import type { RequestListener, Server } from "node:http";
  import type { ServerOptions } from "node:https";

  const httpolyglot: {
    createServer(options: ServerOptions, listener?: RequestListener): Server;
  };

  export default httpolyglot;
}

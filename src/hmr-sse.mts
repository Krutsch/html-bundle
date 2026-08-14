import type { IncomingMessage, ServerResponse } from "http";
import { randomUUID } from "crypto";
import { encodeHMRMessage, type HMRMessage } from "./hmr-protocol.mjs";

export type SSEAdapter = {
  connect(request: IncomingMessage, response: ServerResponse): void;
  publish(message: HMRMessage): void;
};

export function createSSEAdapter(options: {
  keepAlive: boolean;
  serverId?: string;
}): SSEAdapter {
  const connections = new Set<ServerResponse>();
  const serverId = options.serverId || randomUUID();

  function write(response: ServerResponse, message: HMRMessage): void {
    response.write(`data: ${encodeHMRMessage(message)}\n\n`);
  }

  return {
    connect(request, response) {
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      if (options.keepAlive) response.setHeader("Connection", "keep-alive");
      response.flushHeaders();
      write(response, { type: "connected", id: serverId });

      connections.add(response);
      request.on("close", () => connections.delete(response));
    },
    publish(message) {
      connections.forEach((response) => {
        if (response.destroyed || response.writableEnded) {
          connections.delete(response);
          return;
        }

        write(response, message);
      });
    },
  };
}

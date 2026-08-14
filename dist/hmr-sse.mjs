import { randomUUID } from "crypto";
import { encodeHMRMessage } from "./hmr-protocol.mjs";
export function createSSEAdapter(options) {
    const connections = new Set();
    const serverId = options.serverId || randomUUID();
    function write(response, message) {
        response.write(`data: ${encodeHMRMessage(message)}\n\n`);
    }
    return {
        connect(request, response) {
            response.setHeader("Content-Type", "text/event-stream");
            response.setHeader("Cache-Control", "no-cache");
            if (options.keepAlive)
                response.setHeader("Connection", "keep-alive");
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

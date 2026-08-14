import type { IncomingMessage, ServerResponse } from "http";
import { type HMRMessage } from "./hmr-protocol.mjs";
export type SSEAdapter = {
    connect(request: IncomingMessage, response: ServerResponse): void;
    publish(message: HMRMessage): void;
};
export declare function createSSEAdapter(options: {
    keepAlive: boolean;
    serverId?: string;
}): SSEAdapter;

import { decodeHMRMessage, encodeHMRMessage, } from "./hmr-protocol.mjs";
export function createMemoryHMRAdapter() {
    const listeners = new Set();
    return {
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        publish(message) {
            const decoded = decodeHMRMessage(encodeHMRMessage(message));
            if (!decoded)
                return;
            listeners.forEach((listener) => listener(decoded));
        },
    };
}

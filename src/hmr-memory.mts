import {
  decodeHMRMessage,
  encodeHMRMessage,
  type HMRMessage,
} from "./hmr-protocol.mjs";

export type HMRMessageListener = (message: HMRMessage) => void;

export type MemoryHMRAdapter = {
  subscribe(listener: HMRMessageListener): () => void;
  publish(message: HMRMessage): void;
};

export function createMemoryHMRAdapter(): MemoryHMRAdapter {
  const listeners = new Set<HMRMessageListener>();

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(message) {
      const decoded = decodeHMRMessage(encodeHMRMessage(message));
      if (!decoded) return;
      listeners.forEach((listener) => listener(decoded));
    },
  };
}

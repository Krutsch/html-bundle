import { type HMRMessage } from "./hmr-protocol.mjs";
export type HMRMessageListener = (message: HMRMessage) => void;
export type MemoryHMRAdapter = {
    subscribe(listener: HMRMessageListener): () => void;
    publish(message: HMRMessage): void;
};
export declare function createMemoryHMRAdapter(): MemoryHMRAdapter;

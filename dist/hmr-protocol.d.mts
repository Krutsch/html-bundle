export type HMRMessage = {
    type: "connected";
    id: string;
} | {
    type: "html";
    file: string;
    html: string;
    previousHtml?: string;
} | {
    type: "css";
    file: string;
} | {
    type: "asset";
    file: string;
} | {
    type: "full-reload";
    file: string;
};
export declare function isHMRMessage(value: unknown): value is HMRMessage;
export declare function encodeHMRMessage(message: HMRMessage): string;
export declare function decodeHMRMessage(value: string): HMRMessage | undefined;

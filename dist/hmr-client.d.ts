type HTMLMessage = {
    type: "html";
    file: string;
    html: string;
    previousHtml?: string;
};
type HMRMessage = HTMLMessage | {
    type: "css";
    file: string;
} | {
    type: "asset";
    file: string;
} | {
    type: "full-reload";
    file: string;
};
type Hub = {
    currentUnit: string | null;
    lastHTML: Map<string, string>;
    register(file: string, id: string, handler: {
        patch: (message: HTMLMessage) => void;
    }): void;
    addAccept(file: string, callback: () => void): void;
    addDispose(file: string, callback: () => void): void;
    dataFor(file: string): Record<string, unknown>;
    dispatch(message: HMRMessage): void;
};
type HMRPublicAPI = {
    accept(callback: () => void): void;
    dispose(callback: () => void): void;
    readonly data: Record<string, unknown>;
};
declare global {
    interface Window {
        isHMR?: boolean;
        __htmlBundleHMR?: Hub;
        htmlBundleHMR?: HMRPublicAPI;
    }
}
export {};

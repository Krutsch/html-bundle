function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function hasString(record, key) {
    return typeof record[key] === "string";
}
export function isHMRMessage(value) {
    if (!isRecord(value) || typeof value.type !== "string")
        return false;
    if (value.type === "connected") {
        return hasString(value, "id");
    }
    if (value.type === "html") {
        return (hasString(value, "file") &&
            hasString(value, "html") &&
            (value.previousHtml === undefined ||
                typeof value.previousHtml === "string"));
    }
    return ((value.type === "css" ||
        value.type === "asset" ||
        value.type === "full-reload") &&
        hasString(value, "file"));
}
export function encodeHMRMessage(message) {
    if (!isHMRMessage(message)) {
        throw new TypeError("Invalid HMR message");
    }
    return JSON.stringify(message);
}
export function decodeHMRMessage(value) {
    try {
        const message = JSON.parse(value);
        return isHMRMessage(message) ? message : undefined;
    }
    catch {
        return undefined;
    }
}

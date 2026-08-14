export type HMRMessage =
  | { type: "connected"; id: string }
  | {
      type: "html";
      file: string;
      html: string;
      previousHtml?: string;
    }
  | { type: "css"; file: string }
  | { type: "asset"; file: string }
  | { type: "full-reload"; file: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === "string";
}

export function isHMRMessage(value: unknown): value is HMRMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  if (value.type === "connected") {
    return hasString(value, "id");
  }

  if (value.type === "html") {
    return (
      hasString(value, "file") &&
      hasString(value, "html") &&
      (value.previousHtml === undefined ||
        typeof value.previousHtml === "string")
    );
  }

  return (
    (value.type === "css" ||
      value.type === "asset" ||
      value.type === "full-reload") &&
    hasString(value, "file")
  );
}

export function encodeHMRMessage(message: HMRMessage): string {
  if (!isHMRMessage(message)) {
    throw new TypeError("Invalid HMR message");
  }
  return JSON.stringify(message);
}

export function decodeHMRMessage(value: string): HMRMessage | undefined {
  try {
    const message: unknown = JSON.parse(value);
    return isHMRMessage(message) ? message : undefined;
  } catch {
    return undefined;
  }
}

import { mkdir, readdir, readFile, writeFile } from "fs/promises";
import { dirname, join, resolve } from "path";
export async function writeLicenseNotices(inputs, buildDirectory, workingDirectory = process.cwd(), warnMissingLicenses = true) {
    const packages = new Map();
    for (const input of inputs) {
        let directory = dirname(resolve(workingDirectory, input));
        while (directory !== dirname(directory)) {
            if (directory === resolve(process.cwd()))
                break;
            if (packages.has(directory))
                break;
            try {
                const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
                if (typeof metadata.name === "string") {
                    packages.set(directory, metadata);
                    break;
                }
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            directory = dirname(directory);
        }
    }
    const sections = [
        "Third-party notices",
        "Collected from build inputs. Review external dependencies and separately distributed assets.",
    ];
    const sortedPackages = [...packages].sort(([, first], [, second]) => `${first.name}@${first.version || ""}`.localeCompare(`${second.name}@${second.version || ""}`));
    for (const [directory, metadata] of sortedPackages) {
        const label = `${metadata.name}@${metadata.version || "unknown"}`;
        const files = (await readdir(directory, { withFileTypes: true }))
            .filter((entry) => entry.isFile() &&
            /^(?:licen[sc]e|copying|notice)(?:[._-]|$)/i.test(entry.name))
            .map((entry) => entry.name)
            .sort();
        sections.push(`========================================\n${label}`);
        if (typeof metadata.license === "string") {
            sections.push(`License: ${metadata.license}`);
        }
        for (const file of files) {
            sections.push(`${file}\n\n${(await readFile(join(directory, file), "utf8")).trim()}`);
        }
        if (!files.some((file) => /^(?:licen[sc]e|copying)(?:[._-]|$)/i.test(file))) {
            const warning = `No root license file found for ${label}; review its licensing manually.`;
            sections.push(warning);
            if (warnMissingLicenses)
                console.warn(warning);
        }
    }
    await mkdir(buildDirectory, { recursive: true });
    await writeFile(join(buildDirectory, "THIRD-PARTY-NOTICES.txt"), `${sections.join("\n\n")}\n`);
}

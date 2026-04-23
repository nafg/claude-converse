import crypto from "node:crypto";
const SENTENCE_PAUSE = 0.25;
const PARAGRAPH_PAUSE = 0.45;
const ABBREVS = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|vs|etc|approx|dept|est|govt|e\.g|i\.e|a\.m|p\.m|U\.S|Inc|Ltd|Co|Corp|Gen|Gov|Sgt|Pvt|Capt|Lt|Cmdr|Adm|Rev|Hon|Pres|Vol|No)\.$/i;
export const stripEchoPrefix = (text) => {
    const lines = text.split("\n");
    if (lines[0] !== "[heard]")
        return text;
    const end = lines.indexOf("[/heard]", 1);
    if (end === -1)
        return text;
    let i = end + 1;
    while (i < lines.length && lines[i]?.trim() === "")
        i += 1;
    return lines.slice(i).join("\n");
};
export const stripMarkdown = (text) => {
    let out = text;
    out = out.replace(/```[\s\S]*?```/g, " (code omitted) ");
    out = out.replace(/`([^`]+)`/g, "$1");
    out = out.replace(/\*{1,3}(.+?)\*{1,3}/g, "$1");
    out = out.replace(/_{1,3}(.+?)_{1,3}/g, "$1");
    out = out.replace(/^#{1,6}\s+/gm, "");
    out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    out = out.replace(/^[-*_]{3,}\s*$/gm, "");
    out = out.replace(/<[^>]+>/g, "");
    out = out.replace(/^\s*[-*+]\s+/gm, "");
    out = out.replace(/^\s*\d+\.\s+/gm, "");
    return out.trim();
};
const splitSentences = (text) => {
    const words = text.split(/\s+/g).filter(Boolean);
    const sentences = [];
    const current = [];
    for (const word of words) {
        current.push(word);
        if (!/[.!?]$/.test(word))
            continue;
        const joined = current.join(" ");
        if (ABBREVS.test(joined))
            continue;
        if (/^[A-Z]\.$/.test(word))
            continue;
        sentences.push(joined);
        current.length = 0;
    }
    if (current.length > 0)
        sentences.push(current.join(" "));
    return sentences;
};
export const splitSpeechChunks = (text) => {
    if (!text.trim())
        return [];
    const chunks = [];
    const paragraphs = text.split(/\n\n+/g).map((paragraph) => paragraph.trim()).filter(Boolean);
    paragraphs.forEach((paragraph, paragraphIndex) => {
        const lines = paragraph.split("\n");
        const isList = lines.some((line) => /^\s*[-*+]\s|^\s*\d+\.\s/.test(line));
        if (isList) {
            for (const line of lines) {
                const clean = stripMarkdown(line).trim();
                if (clean)
                    chunks.push({ text: clean, pauseSeconds: SENTENCE_PAUSE });
            }
        }
        else {
            const clean = stripMarkdown(paragraph);
            const fullText = clean.split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
            for (const sentence of splitSentences(fullText)) {
                const trimmed = sentence.trim();
                if (trimmed)
                    chunks.push({ text: trimmed, pauseSeconds: SENTENCE_PAUSE });
            }
        }
        if (paragraphIndex < paragraphs.length - 1 && chunks.length > 0) {
            chunks[chunks.length - 1].pauseSeconds = PARAGRAPH_PAUSE;
        }
    });
    if (chunks.length > 0)
        chunks[chunks.length - 1].pauseSeconds = 0;
    return chunks;
};
export const speakableText = (text) => {
    const stripped = stripEchoPrefix(text).trim();
    return stripped ? stripped : null;
};
export const hashText = (text) => crypto.createHash("md5").update(text).digest("hex");

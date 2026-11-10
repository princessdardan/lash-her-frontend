import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
export class QualificationTargetProfileError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = "QualificationTargetProfileError";
    }
}
// Reviewed canonical vector constrains the closed initial source registry.
// It supplies policy identity, never live observations or release authority.
const CURRENT_CANONICAL_BODY = '{"environment":"staging","frontend":{"canonicalOrigin":"https://staging.lashher.com","projectId":"prj_rkTbzWmgdbTGNH2oeajhpc0ysbeM","teamId":"team_2Hrn5eMZyZxfAWdmYvyKi9t3","workloadEnvironment":"production"},"gateway":{"publicOrigin":"https://api-staging.lashher.com"},"id":"staging-current","kind":"existing-staging","selectionPolicy":"existing-staging-v1","version":1}';
const CURRENT_SHA256 = "ea88751524540bfe177e089680b41d6f35b2454d73d17ef9a40b7663381225ba";

const RAW_SHA256 = /^[a-f0-9]{64}$/u;
const PROFILE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const JSON_BOUNDS = Object.freeze({ registry: 131_072, carrier: 2_000_000, "private-packet": 24_000_000 });
const registry = loadSourceRegistry();
function refuse(code) { throw new QualificationTargetProfileError(code); }
/** Detect duplicate decoded keys before ordinary JSON object conversion loses
 * them. Value-only helpers cannot attest the uniqueness of original raw keys. */
export function decodeQualificationTargetJson(raw, kind) {
    try {
        if (typeof kind !== "string" || !Object.hasOwn(JSON_BOUNDS, kind) || !(typeof raw === "string" || raw instanceof Uint8Array))
            refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
        const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : Buffer.from(raw);
        if (bytes.length === 0 || bytes.length > JSON_BOUNDS[kind] || !isUtf8(bytes))
            refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
        const text = bytes.toString("utf8");
        if (typeof raw === "string" && text !== raw || text.charCodeAt(0) === 0xfeff)
            refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
        let offset = 0;
        const whitespace = () => { while (offset < text.length && /[\t\n\r ]/u.test(text[offset]))
            offset++; };
        const string = () => {
            const start = offset++;
            while (offset < text.length) {
                const character = text[offset++];
                if (character === "\\")
                    offset++;
                else if (character === '"') {
                    const decoded = JSON.parse(text.slice(start, offset));
                    if (typeof decoded !== "string" || Buffer.from(decoded).toString("utf8") !== decoded)
                        refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
                    return decoded;
                }
            }
            return refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
        };
        const value = (depth, profileObject = false, canonicalInteger = false) => {
            whitespace();
            const character = text[offset];
            if (canonicalInteger && (character === undefined || !/[0-9]/u.test(character)))
                refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
            if (character === "{") {
                if (depth >= 128)
                    refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
                offset++;
                whitespace();
                const keys = new Set();
                if (text[offset] === "}") {
                    offset++;
                    return;
                }
                while (offset < text.length) {
                    whitespace();
                    if (text[offset] !== '"')
                        refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
                    const key = string();
                    if (keys.has(key))
                        refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
                    keys.add(key);
                    whitespace();
                    if (text[offset++] !== ":")
                        refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
                    value(depth + 1, key === "qualificationTargetProfile", profileObject && key === "version");
                    whitespace();
                    if (text[offset] === "}") {
                        offset++;
                        return;
                    }
                    if (text[offset++] !== ",")
                        refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
                }
                refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
            }
            else if (character === "[") {
                if (depth >= 128)
                    refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
                offset++;
                whitespace();
                if (text[offset] === "]") {
                    offset++;
                    return;
                }
                while (offset < text.length) {
                    value(depth + 1);
                    whitespace();
                    if (text[offset] === "]") {
                        offset++;
                        return;
                    }
                    if (text[offset++] !== ",")
                        refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
                }
                refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
            }
            else if (character === '"') {
                string();
            }
            else {
                const token = /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/u.exec(text.slice(offset))?.[0];
                if (token === undefined)
                    refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
                if (!["true", "false", "null"].includes(token) && !Number.isFinite(Number(token)))
                    refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
                if ((canonicalInteger || kind === "registry" && !["true", "false", "null"].includes(token)) &&
                    (!/^(?:0|[1-9][0-9]*)$/u.test(token) || !Number.isSafeInteger(Number(token))))
                    refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
                offset += token.length;
            }
        };
        value(0);
        whitespace();
        if (offset !== text.length)
            refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
        return JSON.parse(text);
    }
    catch (error) {
        if (error instanceof QualificationTargetProfileError)
            throw error;
        return refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
    }
}
function readRef(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 3 || keys.some(key => typeof key !== "string") ||
        JSON.stringify([...keys].sort()) !== JSON.stringify(["id", "sha256", "version"]))
        refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
    const fields = Object.getOwnPropertyDescriptors(value);
    if (["version", "id", "sha256"].some(key => !fields[key] || !Object.hasOwn(fields[key], "value")))
        refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
    const version = fields.version.value, id = fields.id.value, sha256 = fields.sha256.value;
    if (version !== 1 || typeof id !== "string" || !PROFILE_ID.test(id) || typeof sha256 !== "string" || !RAW_SHA256.test(sha256) || /^0+$/u.test(sha256))
        refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
    return Object.freeze({ version: 1, id, sha256 });
}
function registered(ref) {
    const selected = registry.get(ref.id);
    if (!selected)
        return refuse("QUALIFICATION_TARGET_PROFILE_UNKNOWN");
    const actual = createHash("sha256").update(selected.body).digest("hex");
    if (actual !== selected.sha256 || ref.sha256 !== selected.sha256)
        refuse("QUALIFICATION_TARGET_PROFILE_DIGEST_MISMATCH");
    return selected;
}
/** Shape and source registration are checked together; syntax is insufficient. */
export function parseQualificationTargetProfileRef(value) {
    try {
        const ref = readRef(value);
        registered(ref);
        return ref;
    }
    catch (error) {
        if (error instanceof QualificationTargetProfileError)
            throw error;
        return refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
    }
}
export function resolveQualificationTargetProfile(value) {
    const ref = parseQualificationTargetProfileRef(value), selected = registered(ref);
    const profile = decodeQualificationTargetJson(selected.body, "registry");
    Object.freeze(profile.frontend);
    Object.freeze(profile.gateway);
    return Object.freeze(profile);
}
export function requireQualificationTargetProfile(expected, ...carriers) {
    if (carriers.length === 0)
        refuse("QUALIFICATION_TARGET_PROFILE_REQUIRED");
    const ref = parseQualificationTargetProfileRef(expected);
    try {
        for (const carrier of carriers) {
            if (typeof carrier !== "object" || carrier === null || Array.isArray(carrier))
                refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
            const field = Object.getOwnPropertyDescriptor(carrier, "qualificationTargetProfile");
            if (!field)
                refuse("qualificationTargetProfile" in carrier ? "QUALIFICATION_TARGET_PROFILE_REFUSED" : "QUALIFICATION_TARGET_PROFILE_REQUIRED");
            if (!Object.hasOwn(field, "value"))
                refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
            const actual = parseQualificationTargetProfileRef(field.value);
            if (actual.version !== ref.version || actual.id !== ref.id || actual.sha256 !== ref.sha256)
                refuse("QUALIFICATION_TARGET_PROFILE_MISMATCH");
        }
        return ref;
    }
    catch (error) {
        if (error instanceof QualificationTargetProfileError)
            throw error;
        return refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
    }
}
export const STAGING_CURRENT_QUALIFICATION_TARGET_PROFILE = parseQualificationTargetProfileRef({ version: 1, id: "staging-current", sha256: CURRENT_SHA256 });

// Fixed source data only. No caller-selected file, remote registry, environment
// selector or incomplete isolated definition can enter this initial registry.
function loadSourceRegistry() {
    let descriptor;
    try {
        const file = new URL("./qualification-target-profiles.json", import.meta.url);
        if (![constants.O_NOFOLLOW, constants.O_NONBLOCK].every(flag => Number.isInteger(flag) && flag > 0))
            refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
        descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = fstatSync(descriptor);
        if (!before.isFile() || before.size < 1 || before.size > JSON_BOUNDS.registry)
            refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
            if (count < 1) refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
            offset += count;
        }
        if (readSync(descriptor, Buffer.alloc(1), 0, 1, null) !== 0) refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
        const after = fstatSync(descriptor);
        if (["dev", "ino", "size", "mtimeMs", "ctimeMs"].some(key => before[key] !== after[key]))
            refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
        const envelope = decodeQualificationTargetJson(bytes, "registry");
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
            JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(["profiles", "version"]) || envelope.version !== 1 ||
            !Array.isArray(envelope.profiles) || envelope.profiles.length < 1 || envelope.profiles.length > 8)
            refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
        const result = new Map(), hashes = new Set();
        let previous;
        for (const definition of envelope.profiles) {
            const body = JSON.stringify(canonicalSourceDefinition(definition));
            // A future allocated definition needs its own reviewed concrete
            // schema and real IDs. It cannot select this existing policy.
            if (body !== CURRENT_CANONICAL_BODY || definition.id !== "staging-current" ||
                previous !== undefined && previous >= definition.id)
                refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
            const sha256 = createHash("sha256").update(body).digest("hex");
            if (hashes.has(sha256) || result.has(definition.id)) refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
            hashes.add(sha256); previous = definition.id;
            result.set(definition.id, { body, sha256 });
        }
        return result;
    } catch (error) {
        if (error instanceof QualificationTargetProfileError) throw error;
        return refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
    } finally {
        if (descriptor !== undefined) closeSync(descriptor);
    }
}

function canonicalSourceDefinition(value) {
    if (typeof value === "string") {
        if (!/^[\x20-\x7e]*$/u.test(value)) refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
        return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (Array.isArray(value)) return value.map(canonicalSourceDefinition);
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
        refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
    const keys = Object.keys(value).sort();
    for (const key of keys) if (!/^[\x20-\x7e]+$/u.test(key)) refuse("QUALIFICATION_TARGET_PROFILE_REFUSED");
    return Object.fromEntries(keys.map(key => [key, canonicalSourceDefinition(value[key])]));
}

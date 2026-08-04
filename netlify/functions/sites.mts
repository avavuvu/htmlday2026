import { getStore } from "@netlify/blobs";
import { unzipSync } from "fflate";

const MIME: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css",
    js: "text/javascript",
    mjs: "text/javascript",
    json: "application/json",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    txt: "text/plain; charset=utf-8",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    wasm: "application/wasm",
};

const RESERVED = new Set(["upload", "rsvps", "favicon.png", "index.html"]);
const NAME_PATTERN = /^[a-z0-9-]{1,30}$/;
const MAX_ZIP_BYTES = 5_000_000;

export default async (req: Request) => {
    const url = new URL(req.url);
    // path is the original url when invoked via rewrite, but strip the
    // function prefix in case it's hit directly
    const path = url.pathname.replace(/^\/\.netlify\/functions\/sites/, "");
    const store = getStore("sites");

    if (req.method === "POST" && path === "/upload") {
        return handleUpload(req, store);
    }

    const segments = path.split("/").filter(Boolean);
    const name = segments[0]?.toLowerCase();

    if (!name || !NAME_PATTERN.test(name) || RESERVED.has(name)) {
        return new Response("no such page", { status: 404 });
    }

    // relative urls inside pages only resolve correctly under /name/
    if (segments.length === 1 && !path.endsWith("/")) {
        return Response.redirect(new URL(`${url.pathname}/`, url), 301);
    }

    let key = segments.join("/");
    if (path.endsWith("/")) key += "/index.html";

    const blob = await store.get(key, { type: "arrayBuffer" });
    if (!blob) {
        return new Response("no such page", { status: 404 });
    }

    const ext = key.split(".").pop()?.toLowerCase() ?? "";
    return new Response(blob, {
        headers: {
            "content-type": MIME[ext] ?? "application/octet-stream",
        },
    });
};

async function handleUpload(req: Request, store: ReturnType<typeof getStore>) {
    const form = await req.formData();
    const name = String(form.get("name") ?? "")
        .trim()
        .toLowerCase();
    const file = form.get("zip");

    if (!NAME_PATTERN.test(name) || RESERVED.has(name)) {
        return new Response("name must be 1-30 chars of a-z, 0-9, or -", {
            status: 400,
        });
    }
    if (!(file instanceof File) || file.size === 0) {
        return new Response("attach a zip file", { status: 400 });
    }
    if (file.size > MAX_ZIP_BYTES) {
        return new Response("zip too big, keep it under 5mb", { status: 413 });
    }

    let unzipped: Record<string, Uint8Array>;
    try {
        unzipped = unzipSync(new Uint8Array(await file.arrayBuffer()));
    } catch {
        return new Response("that's not a valid zip file", { status: 400 });
    }

    let entries = Object.entries(unzipped).filter(
        ([p]) =>
            !p.endsWith("/") &&
            !p.split("/").some((s) => s.startsWith(".") || s === "__MACOSX"),
    );

    // macos zips wrap everything in a folder; unwrap it
    if (!entries.some(([p]) => p === "index.html")) {
        const tops = new Set(entries.map(([p]) => p.split("/")[0]));
        if (tops.size === 1) {
            entries = entries.map(([p, data]) => [
                p.split("/").slice(1).join("/"),
                data,
            ]);
        }
    }

    if (!entries.some(([p]) => p === "index.html")) {
        return new Response("zip needs an index.html at its root", {
            status: 400,
        });
    }

    // clear the old site so removed files don't linger
    const { blobs } = await store.list({ prefix: `${name}/` });
    await Promise.all(blobs.map((b) => store.delete(b.key)));

    await Promise.all(
        entries.map(([p, data]) => store.set(`${name}/${p}`, new Blob([data as any]))),
    );

    return new Response(null, {
        status: 303,
        headers: { location: `/${name}/` },
    });
}

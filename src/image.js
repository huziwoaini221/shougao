import { ghFetch, GHError, ownerOf } from "./github.js";
import { err } from "./http.js";

const VOLUME_RE = /^manuscript-\d{1,4}$/;

function safePath(p) {
	if (typeof p !== "string" || !p || p.length > 300) return null;
	if (p.includes("..") || p.startsWith("/") || p.includes("\\")) return null;
	if (/[<>:"|?*]/.test(p)) return null;
	return p;
}

function contentTypes(ext) {
	const map = {
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".png": "image/png",
		".webp": "image/webp",
		".gif": "image/gif",
		".bmp": "image/bmp",
		".avif": "image/avif",
	};
	const e = (ext || "").toLowerCase();
	if (map[e]) return map[e];
	if (e.startsWith(".")) return "application/octet-stream";
	return "application/octet-stream";
}

export async function handleImage(url, env, ctx) {
	const repo = url.searchParams.get("repo") || "";
	const path = safePath(url.searchParams.get("path"));

	if (!VOLUME_RE.test(repo) || repo.indexOf(env.REPO_PREFIX || "manuscript") !== 0) {
		return err(400, "bad_repo", "仓库名不合法。");
	}
	if (!path) return err(400, "bad_path", "图片路径不合法。");

	try {
		const res = await ghFetch(
			env,
			`/repos/${ownerOf(env)}/${repo}/contents/${path}`,
			{
				headers: { Accept: "application/vnd.github.v3.raw" },
			}
		);

		const ext = path.slice(path.lastIndexOf("."));
		const headers = new Headers(res.headers);

		headers.set("content-type", contentTypes(ext));
		headers.set("cache-control", "public, max-age=86400");
		headers.set(
			"content-disposition",
			`inline; filename="${path.slice(path.lastIndexOf("/") + 1).replace(/"/g, "")}"`
		);

		if (!headers.has("etag") && res.headers.get("etag")) {
			headers.set("etag", res.headers.get("etag"));
		}
		if (res.headers.get("last-modified")) {
			headers.set("last-modified", res.headers.get("last-modified"));
		}
		if (res.headers.get("content-length")) {
			headers.set("content-length", res.headers.get("content-length"));
		}

		return new Response(res.body, { status: res.status, headers });
	} catch (e) {
		if (e instanceof GHError && e.status === 404) {
			return new Response("not found", { status: 404 });
		}
		return new Response("image proxy error", { status: 502 });
	}
}
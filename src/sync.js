import { ownerOf, getRepoDefaultBranch, getFileJSON, repoName, repoExists, commitFiles } from "./github.js";
import { err, json } from "./http.js";

const CATALOG_PATH = "data/catalog.json";
const VOLUME_RE = /^manuscript-\d{1,4}$/;

export async function loadCatalog(env, repo) {
	const webRepo = repo || env.WEB_REPO || "manuscript-web";
	const catalog = await getFileJSON(env, webRepo, CATALOG_PATH);
	return catalog;
}

export async function saveCatalog(env, catalog, webRepo) {
	const branch = await getRepoDefaultBranch(env, webRepo);
	await commitCatalog(env, { repo: webRepo, branch, catalog, message: "Update catalog" });
}

async function commitCatalog(env, { repo, branch, catalog, message }) {
	return commitFiles(env, {
		repo,
		branch,
		message,
		files: [
			{
				path: CATALOG_PATH,
				content: JSON.stringify(catalog, null, 2),
				encoding: "utf-8",
			},
		],
	});
}

export async function handleGetCatalog(env) {
	try {
		const catalog = await loadCatalog(env);
		if (!catalog) return err(404, "no_catalog", "总索引不存在，可能尚未初始化。");
		return json({ ok: true, catalog });
	} catch (e) {
		return githubError(e);
	}
}

export async function handleGetStatus(env) {
	try {
		const catalog = await loadCatalog(env);
		return json({
			ok: true,
			owner: ownerOf(env) || "",
			webRepo: env.WEB_REPO || "manuscript-web",
			activeVolume: catalog ? catalog.active_volume : null,
			volumes: catalog ? catalog.volumes : [],
		});
	} catch (e) {
		return githubError(e);
	}
}

export async function handleGetManifest(url, env) {
	const volume = url.searchParams.get("volume") || "";
	if (!VOLUME_RE.test(volume)) {
		return err(400, "bad_volume", "仓库名不合法：", volume);
	}
	try {
		if (!(await repoExists(env, volume))) {
			return err(404, "no_volume", `卷不存在：${volume}`);
		}
		const manifest = await getFileJSON(env, volume, "manifest.json");
		return json({ ok: true, volume, manifest: manifest || null });
	} catch (e) {
		return githubError(e);
	}
}

export function githubError(e) {
	if (e && e.status && e.code) {
		return err(e.status, e.code, e.message, e.details);
	}
	return err(500, "internal", e && e.message ? e.message : "服务器内部错误");
}

export { VOLUME_RE, CATALOG_PATH };
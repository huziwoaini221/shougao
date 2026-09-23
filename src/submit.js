import {
	repoName,
	repoExists,
	createRepo,
	commitFiles,
	computeVolumeUsageBytes,
	getRepoDefaultBranch,
	getFileJSON,
	GHError,
} from "./github.js";
import { loadCatalog, saveCatalog, githubError } from "./sync.js";
import { err, json } from "./http.js";

const DATAURL_RE = /^data:image\/(jpeg|png|webp|gif|bmp);base64,/i;

function extForMime(dataUrlPrefix) {
	const s = (dataUrlPrefix || "").toLowerCase();
	if (s.startsWith("data:image/png")) return "png";
	if (s.startsWith("data:image/webp")) return "webp";
	if (s.startsWith("data:image/gif")) return "gif";
	if (s.startsWith("data:image/bmp")) return "bmp";
	return "jpg";
}

function base64Bytes(b64) {
	const clean = b64.replace(/\s/g, "");
	return Math.floor((clean.length * 3) / 4) - (clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0);
}

function dataUrlBytes(dataUrl) {
	const comma = dataUrl.indexOf(",");
	return base64Bytes(dataUrl.slice(comma + 1));
}

function pad(n, w) {
	return String(n).padStart(w, "0");
}

function todayISO() {
	return new Date().toISOString().slice(0, 10);
}

function cleanStr(v) {
	return typeof v === "string" ? v.trim() : "";
}

export async function handleSubmit(request, env) {
	let body;
	try {
		body = await request.json();
	} catch {
		return err(400, "bad_json", "请求格式错误。");
	}

	const mode = body.mode === "update" ? "update" : "create";
	const draft = body.draft || {};
	const rawImages = Array.isArray(body.images) ? body.images : [];

	const date = cleanStr(draft.date);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		return err(400, "bad_date", "日期格式应为 YYYY-MM-DD。");
	}

	const images = rawImages.map((im) => ({
		name: cleanStr(im.name) || "photo",
		dataUrl: String(im.dataUrl || ""),
	}));
	for (const im of images) {
		if (!DATAURL_RE.test(im.dataUrl)) {
			return err(400, "bad_image", "照片格式不支持：" + im.name);
		}
	}
	const newBytes = images.reduce((sum, im) => sum + dataUrlBytes(im.dataUrl), 0);

	const threshold = parseInt(env.THRESHOLD_MB || "380", 10) * 1024 * 1024;
	const hardCap = parseInt(env.HARD_CAP_MB || "400", 10) * 1024 * 1024;
	const webRepo = env.WEB_REPO || "manuscript-web";

	try {
		const webRepoExists = await repoExistsSafe(env, webRepo);
		if (!webRepoExists) {
			await createRepo(env, webRepo);
		}

		const catalog = await loadCatalog(env);
		let result;

		if (mode === "create") {
			result = await createManuscript(env, {
				draft,
				date,
				images,
				newBytes,
				catalog,
				threshold,
				hardCap,
				webRepo,
			});
		} else {
			result = await updateManuscript(env, {
				draft,
				date,
				images,
				newBytes,
				catalog,
				webRepo,
			});
		}

		return json({
			ok: true,
			mode,
			id: result.id,
			repository: result.repository,
			commitSha: result.commitSha,
			sizeMb: result.sizeMb,
			images: result.imagePaths,
			url: `#/view/${result.id}?image=01`,
			message: result.message,
		});
	} catch (e) {
		return githubError(e);
	}
}

async function repoExistsSafe(env, name) {
	try {
		return await repoExists(env, name);
	} catch (e) {
		if (e instanceof GHError && e.status === 404) return false;
		throw e;
	}
}

async function ensureVolume(env, n, catalog) {
	const name = repoName(env, n);
	if (!(await repoExistsSafe(env, name))) {
		await createRepo(env, name);
	}
	if (!catalog.volumes) catalog.volumes = [];
	let vol = catalog.volumes.find((v) => v.name === name);
	if (!vol) {
		vol = { name, size_mb: 0, status: "active", created: todayISO(), closed: null };
		catalog.volumes.push(vol);
	}
	return vol;
}

function nextVolumeNumber(catalog) {
	let max = 0;
	for (const v of catalog.volumes || []) {
		const m = /-(\d{1,4})$/.exec(v.name || "");
		if (m) max = Math.max(max, parseInt(m[1], 10));
	}
	return max + 1;
}

async function loadManifest(env, repository) {
	const m = await getFileJSON(env, repository, "manifest.json");
	if (m) return m;
	return {
		volume: repository,
		status: "active",
		created: todayISO(),
		closed: null,
		size_bytes: 0,
		manuscripts: [],
	};
}

function buildEntry(id, draft, date, imagePaths) {
	return {
		id,
		date,
		title: cleanStr(draft.title) || "未命名",
		category: cleanStr(draft.category) || "未分类",
		tags: Array.isArray(draft.tags)
			? draft.tags.map((t) => cleanStr(t)).filter(Boolean)
			: [],
		note: cleanStr(draft.note),
		images: imagePaths.slice(),
	};
}

function parseDateCompact(date) {
	const d = date.replace(/-/g, "");
	return { compact: d, year: d.slice(0, 4), month: d.slice(4, 6) };
}

async function createManuscript(env, { draft, date, images, newBytes, catalog, threshold, hardCap, webRepo }) {
	const { compact, year, month } = parseDateCompact(date);

	if (!catalog) {
		catalog = { active_volume: null, volumes: [] };
	}

	let targetName;
	let volumeUsedBytes;

	if (!catalog.active_volume) {
		targetName = repoName(env, 1);
		await ensureVolume(env, 1, catalog);
		volumeUsedBytes = 0;
	} else {
		targetName = catalog.active_volume;
		const usage = await computeVolumeUsageBytes(env, targetName);
		volumeUsedBytes = usage.bytes;
		if (volumeUsedBytes + newBytes > threshold) {
			const n = nextVolumeNumber(catalog);
			targetName = repoName(env, n);
			await ensureVolume(env, n, catalog);
			volumeUsedBytes = 0;
		}
	}

	if (volumeUsedBytes + newBytes > hardCap) {
		throw new GHError(413, "volume_full", "当前卷已接近 400 MB 上限，请先整理归档。");
	}

	const manifest = await loadManifest(env, targetName);
	const seq = (manifest.manuscripts || []).filter((m) => m.id.startsWith(compact)).length + 1;
	const id = `${compact}-${pad(seq, 3)}`;

	const dir = `${year}/${month}`;
	const imagePaths = [];
	const files = [];
	images.forEach((im, i) => {
		const filename = `${id}-${pad(i + 1, 2)}.${extForMime(im.dataUrl.slice(0, 24))}`;
		const path = `${dir}/${filename}`;
		imagePaths.push(path);
		files.push({
			path,
			content: im.dataUrl.slice(im.dataUrl.indexOf(",") + 1),
			encoding: "base64",
		});
	});

	const entry = buildEntry(id, draft, date, imagePaths);
	if (!manifest.manuscripts) manifest.manuscripts = [];
	manifest.manuscripts.push(entry);
	manifest.size_bytes = volumeUsedBytes + newBytes;

	files.push({
		path: "manifest.json",
		content: JSON.stringify(manifest, null, 2),
		encoding: "utf-8",
	});

	const branch = await getRepoDefaultBranch(env, targetName);
	const result = await commitFiles(env, {
		repo: targetName,
		branch,
		message: `Add manuscript ${id}`,
		files,
	});

	await updateCatalogAfterWrite(env, catalog, targetName, volumeUsedBytes + newBytes, webRepo);

	return {
		id,
		repository: targetName,
		commitSha: result.commitSha,
		sizeMb: Math.round((volumeUsedBytes + newBytes) / (1024 * 1024)),
		imagePaths,
		message: `已同步到 ${targetName}`,
	};
}

async function updateManuscript(env, { draft, date, images, newBytes, catalog, webRepo }) {
	const id = cleanStr(draft.id);
	if (!/^\d{8}-\d{3}$/.test(id)) {
		throw new GHError(400, "bad_id", "手稿 ID 不合法。");
	}
	const repository = cleanStr(draft.repository);
	if (!/^manuscript-\d{1,4}$/.test(repository)) {
		throw new GHError(400, "bad_repo", "仓库名不合法。");
	}

	const year = id.slice(0, 4);
	const month = id.slice(4, 6);

	const manifest = await loadManifest(env, repository);
	const entry = (manifest.manuscripts || []).find((m) => m.id === id);
	if (!entry) {
		throw new GHError(404, "no_manuscript", `在 ${repository} 中未找到手稿 ${id}。`);
	}

	entry.title = cleanStr(draft.title) || entry.title || "未命名";
	entry.category = cleanStr(draft.category) || entry.category || "未分类";
	entry.tags = Array.isArray(draft.tags)
		? draft.tags.map((t) => cleanStr(t)).filter(Boolean)
		: [];
	entry.note = cleanStr(draft.note);

	const dir = `${year}/${month}`;
	const start = (entry.images || []).length;
	const newPaths = [];
	const files = [];
	images.forEach((im, i) => {
		const filename = `${id}-${pad(start + i + 1, 2)}.${extForMime(im.dataUrl.slice(0, 24))}`;
		const path = `${dir}/${filename}`;
		newPaths.push(path);
		files.push({
			path,
			content: im.dataUrl.slice(im.dataUrl.indexOf(",") + 1),
			encoding: "base64",
		});
	});
	entry.images = entry.images.concat(newPaths);
	manifest.size_bytes = (manifest.size_bytes || 0) + newBytes;

	files.push({
		path: "manifest.json",
		content: JSON.stringify(manifest, null, 2),
		encoding: "utf-8",
	});

	const branch = await getRepoDefaultBranch(env, repository);
	const result = await commitFiles(env, {
		repo: repository,
		branch,
		message: `Update manuscript ${id}`,
		files,
	});

	if (catalog) {
		const vol = catalog.volumes.find((v) => v.name === repository);
		if (vol && typeof vol.size_mb === "number") {
			vol.size_mb = Math.round((vol.size_mb + newBytes / (1024 * 1024)) * 10) / 10;
		}
		await saveCatalog(env, catalog, webRepo);
	}

	return {
		id,
		repository,
		commitSha: result.commitSha,
		sizeMb: undefined,
		imagePaths: newPaths,
		message: `已更新 ${repository} 中的 ${id}`,
	};
}

async function updateCatalogAfterWrite(env, catalog, targetName, totalBytes, webRepo) {
	catalog.active_volume = targetName;
	catalog.volumes.forEach((v) => {
		if (v.name === targetName) {
			if (typeof v.size_mb === "number") v.size_mb = Math.round(totalBytes / (1024 * 1024));
		}
		if (v.name !== targetName && v.status === "active") {
			v.status = "archived";
			v.closed = todayISO();
		}
	});
	await saveCatalog(env, catalog, webRepo);
}
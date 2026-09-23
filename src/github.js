const GH_API = "https://api.github.com";

export class GHError extends Error {
	constructor(status, code, message, details) {
		super(message);
		this.status = status;
		this.code = code;
		this.details = details;
		this.name = "GHError";
	}
}

function requireToken(env) {
	if (!env.GH_TOKEN) {
		throw new GHError(503, "no_token", "GitHub Token 未配置（GH_TOKEN Secret）。");
	}
}

export function ownerOf(env) {
	const owner = env.OWNER || "";
	if (!owner) {
		throw new GHError(503, "no_owner", "GitHub 用户名未配置（OWNER 变量）。");
	}
	return owner;
}

export function repoName(env, n) {
	const prefix = (env.REPO_PREFIX || "manuscript").replace(/-+$/, "");
	return `${prefix}-${String(n).padStart(4, "0")}`;
}

export async function ghFetch(env, path, opts = {}) {
	requireToken(env);
	const headers = {
		Authorization: `Bearer ${env.GH_TOKEN}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
	};
	if (opts.headers) Object.assign(headers, opts.headers);

	const res = await fetch(GH_API + path, {
		method: opts.method || "GET",
		headers,
		body: opts.body ? JSON.stringify(opts.body) : undefined,
		redirect: "follow",
	});

	if (!res.ok) {
		let details = null;
		try {
			const d = await res.json();
			details = d.message || JSON.stringify(d);
		} catch {
			details = await res.text().catch(() => null);
		}
		const code = res.status === 409 ? "conflict" : res.status === 404 ? "missing" : "github";
		throw new GHError(res.status, code, `GitHub API 请求失败：${path}`, details);
	}
	return res;
}

export async function getRepoDefaultBranch(env, repo) {
	const res = await ghFetch(env, `/repos/${ownerOf(env)}/${repo}`);
	const data = await res.json();
	return data.default_branch || "main";
}

export async function getFileJSON(env, repo, path) {
	const res = await ghFetch(env, `/repos/${ownerOf(env)}/${repo}/contents/${path}`).catch((e) => {
		if (e instanceof GHError && e.status === 404) return null;
		throw e;
	});
	if (!res) return null;
	const data = await res.json();
	if (data.encoding !== "base64") return null;
	const str = decodeBase64(data.content);
	try {
		return JSON.parse(str);
	} catch {
		return null;
	}
}

export async function getFileMeta(env, repo, path) {
	const res = await ghFetch(env, `/repos/${ownerOf(env)}/${repo}/contents/${path}`);
	return res.json();
}

export function decodeBase64(b64) {
	const clean = b64.replace(/\s/g, "");
	const bin = atob(clean);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

export async function repoExists(env, repo) {
	const res = await ghFetch(env, `/repos/${ownerOf(env)}/${repo}`).catch((e) => {
		if (e.status === 404) return null;
		throw e;
	});
	return res !== null;
}

export async function createRepo(env, repo) {
	const owner = ownerOf(env);
	const body = {
		name: repo,
		private: true,
		auto_init: true,
		description: "文稿分卷档案卷 " + repo,
	};
	const res = await ghFetch(env, `/user/repos`, { method: "POST", body });
	await res.json();
}

export async function computeVolumeUsageBytes(env, repo) {
	const branch = await getRepoDefaultBranch(env, repo).catch((e) => {
		if (e.status === 404) throw e;
		throw e;
	});
	const res = await ghFetch(
		env,
		`/repos/${ownerOf(env)}/${repo}/git/trees/${branch}?recursive=1`
	);
	const data = await res.json();
	let bytes = 0;
	if (Array.isArray(data.tree)) {
		for (const item of data.tree) {
			if (item.type === "blob" && typeof item.size === "number") {
				bytes += item.size;
			}
		}
	}
	return { bytes, branch, truncated: !!data.truncated };
}

export async function getRefHead(env, repo, branch) {
	const res = await ghFetch(env, `/repos/${ownerOf(env)}/${repo}/git/ref/heads/${branch}`);
	const data = await res.json();
	if (!data || !data.object || !data.object.sha) {
		throw new GHError(500, "no_ref", `无法获取 ${repo} 的分支 ${branch}`);
	}
	return data.object.sha;
}

async function getCommitTree(env, repo, sha) {
	const res = await ghFetch(env, `/repos/${ownerOf(env)}/${repo}/git/commits/${sha}`);
	const data = await res.json();
	return data.tree.sha;
}

async function createBlob(env, repo, content, encoding) {
	const res = await ghFetch(env, `/repos/${ownerOf(env)}/${repo}/git/blobs`, {
		method: "POST",
		body: { content, encoding },
	});
	const data = await res.json();
	return data.sha;
}

async function createTree(env, repo, opts) {
	const res = await ghFetch(env, `/repos/${ownerOf(env)}/${repo}/git/trees`, {
		method: "POST",
		body: opts,
	});
	const data = await res.json();
	return data.sha;
}

async function createCommit(env, repo, message, treeSha, parents) {
	const res = await ghFetch(env, `/repos/${ownerOf(env)}/${repo}/git/commits`, {
		method: "POST",
		body: { message, tree: treeSha, parents },
	});
	const data = await res.json();
	return data.sha;
}

export async function updateRef(env, repo, branch, sha, expectedSha) {
	const res = await ghFetch(env, `/repos/${ownerOf(env)}/${repo}/git/refs/heads/${branch}`, {
		method: "PATCH",
		body: { sha, force: false, expected_sha: expectedSha },
	});
	return res.json();
}

export async function commitFiles(env, { repo, branch, message, files, expectedSha }) {
	const headSha = await getRefHead(env, repo, branch);
	const baseTree = await getCommitTree(env, repo, headSha);

	const tree = [];
	for (const f of files) {
		const encoding = f.encoding || "utf-8";
		const blobSha = await createBlob(env, repo, f.content, encoding);
		tree.push({
			path: f.path,
			mode: "100644",
			type: "blob",
			sha: blobSha,
		});
	}

	const treeSha = await createTree(env, repo, {
		base_tree: baseTree,
		tree,
	});

	const commitSha = await createCommit(env, repo, message, treeSha, [headSha]);

	await updateRef(env, repo, branch, commitSha, expectedSha === undefined ? headSha : expectedSha);
	return { commitSha, headSha };
}
import { json } from "./http.js";

export function handleConfig(env) {
	return json({
		ok: true,
		owner: env.OWNER || "",
		repoPrefix: env.REPO_PREFIX || "manuscript",
		webRepo: env.WEB_REPO || "manuscript-web",
		imageMaxEdge: parseInt(env.IMAGE_MAX_EDGE || "1920", 10),
		imageQuality: parseFloat(env.IMAGE_QUALITY || "0.82"),
		hasGitHub: !!env.GH_TOKEN,
	});
}
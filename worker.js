import { handleSubmit } from "./src/submit.js";
import { handleGetCatalog, handleGetManifest, handleGetStatus } from "./src/sync.js";
import { handleImage } from "./src/image.js";
import { handleConfig } from "./src/config.js";
import { checkAuth } from "./src/auth.js";
import { json, err } from "./src/http.js";

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const { pathname } = url;

		if (pathname === "/api/config" && request.method === "GET") {
			return handleConfig(env);
		}

		if (pathname === "/api/catalog" && request.method === "GET") {
			return handleGetCatalog(env);
		}

		if (pathname === "/api/status" && request.method === "GET") {
			return handleGetStatus(env);
		}

		if (pathname === "/api/manifest" && request.method === "GET") {
			return handleGetManifest(url, env);
		}

		if (pathname === "/api/image" && request.method === "GET") {
			return handleImage(url, env, ctx);
		}

		if (pathname === "/api/submit" && request.method === "POST") {
			const auth = await checkAuth(request, env);
			if (!auth.ok) {
				return err(401, "unauthorized", "认证未通过，请先登录。");
			}
			return handleSubmit(request, env);
		}

		if (pathname.startsWith("/api/")) {
			return err(404, "not_found", "接口不存在。");
		}

		return env.ASSETS.fetch(request);
	},
};
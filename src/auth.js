export async function checkAuth(request, env) {
	if (env.REQUIRE_CF_ACCESS && env.REQUIRE_CF_ACCESS !== "0") {
		const email = request.headers.get("cf-access-authenticated-user-email");
		if (!email) return { ok: false, reason: "cf_access" };
	}

	if (env.APP_TOKEN && env.APP_TOKEN !== "0") {
		const token = request.headers.get("x-app-token");
		if (!token || token !== env.APP_TOKEN) {
			return { ok: false, reason: "app_token" };
		}
	}

	return { ok: true };
}
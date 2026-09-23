export function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

export function err(status, code, error, details) {
	const body = { ok: false, code, error };
	if (details !== undefined) body.details = details;
	return json(body, status);
}
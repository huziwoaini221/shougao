"use strict";

const $ = (sel) => document.querySelector(sel);

const state = {
	config: null,
	catalog: null,
	catalogError: null,
	loaded: false,
	index: [],       // merged manuscript entries { ...entry, volume }
	manifests: {},   // volume -> manifest
	hydrating: false,
	drafts: loadDrafts(),
	form: null,      // current form state in /new
	currentDraftKey: null,
};

/* ---------- 小工具 ---------- */

function esc(s) {
	return String(s == null ? "" : s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function fmtMb(n) {
	if (n == null || isNaN(n)) return "-";
	return n + " MB";
}

function filenameOf(path) {
	const p = String(path || "");
	return p.slice(p.lastIndexOf("/") + 1);
}

function todayLocal() {
	const d = new Date();
	const p = (x) => String(x).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toast(msg, isErr) {
	const t = $("#toast");
	if (!t) return;
	t.textContent = msg;
	t.className = "toast show" + (isErr ? " err" : "");
	clearTimeout(toast._t);
	toast._t = setTimeout(() => (t.className = "toast"), 2600);
}

/* ---------- API ---------- */

async function api(path, opts) {
	const res = await fetch(path, opts);
	let body = null;
	try { body = await res.json(); } catch {}
	if (!res.ok) {
		const e = new Error(body && body.error ? body.error : res.statusText || "请求失败");
		e.code = body && body.code;
		e.status = res.status;
		e.details = body && body.details;
		throw e;
	}
	return body;
}

function apiImage(repo, path) {
	return `/api/image?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`;
}

/* ---------- 图片处理（前端压缩 + 自动旋转，避免过度压缩） ---------- */

async function loadBitmap(file) {
	try {
		return await createImageBitmap(file, { imageOrientation: "from-image" });
	} catch {
		try {
			return await createImageBitmap(file);
		} catch {
			return await new Promise((resolve, reject) => {
				const img = new Image();
				img.onload = () => resolve(img);
				img.onerror = () => reject(new Error("无法读取图片"));
				img.src = URL.createObjectURL(file);
			});
		}
	}
}

async function processImage(file) {
	const bmp = await loadBitmap(file);
	const maxEdge = (state.config && state.config.imageMaxEdge) || 1920;
	const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
	const w = Math.max(1, Math.round(bmp.width * scale));
	const h = Math.max(1, Math.round(bmp.height * scale));
	const canvas = document.createElement("canvas");
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext("2d");
	ctx.fillStyle = "#fff";
	ctx.fillRect(0, 0, w, h);
	ctx.drawImage(bmp, 0, 0, w, h);
	const quality = (state.config && state.config.imageQuality) || 0.82;
	const dataUrl = canvas.toDataURL("image/jpeg", quality);
	return { name: file.name, dataUrl, w, h };
}

/* ---------- 草稿（LocalStorage） ---------- */

const DRAFT_KEY = "ms.drafts.v1";

function loadDrafts() {
	try {
		const v = JSON.parse(localStorage.getItem(DRAFT_KEY) || "[]");
		return Array.isArray(v) ? v : [];
	} catch { return []; }
}

function persistDrafts() {
	try {
		localStorage.setItem(DRAFT_KEY, JSON.stringify(state.drafts));
		return true;
	} catch {
		toast("本地存储已满，保存草稿失败。", true);
		return false;
	}
}

function upsertDraft(draft) {
	const i = state.drafts.findIndex((d) => d.key === draft.key);
	if (i >= 0) state.drafts[i] = draft;
	else state.drafts.unshift(draft);
	persistDrafts();
}

function removeDraft(key) {
	state.drafts = state.drafts.filter((d) => d.key !== key);
	persistDrafts();
}

/* ---------- 索引加载（按卷懒加载） ---------- */

async function ensureManifest(volume) {
	if (state.manifests[volume]) return state.manifests[volume];
	try {
		const r = await api(`/api/manifest?volume=${encodeURIComponent(volume)}`);
		if (r.manifest) {
			state.manifests[volume] = r.manifest;
			for (const m of r.manifest.manuscripts || []) {
				state.index.push({ ...m, volume });
			}
		}
		return r.manifest;
	} catch {
		return null;
	}
}

async function refreshManifest(volume) {
	delete state.manifests[volume];
	state.index = state.index.filter((e) => e.volume !== volume);
	await ensureManifest(volume);
}

async function ensureAllManifests() {
	if (!state.catalog || !state.catalog.volumes) return;
	for (const v of state.catalog.volumes) {
		await ensureManifest(v.name);
	}
}

async function findManuscript(id) {
	for (const e of state.index) {
		if (e.id === id) return { entry: e, volume: e.volume };
	}
	await ensureAllManifests();
	for (const e of state.index) {
		if (e.id === id) return { entry: e, volume: e.volume };
	}
	return null;
}

async function hydrate() {
	if (state.hydrating || !state.catalog) return;
	state.hydrating = true;
	render();
	await ensureAllManifests();
	state.hydrating = false;
	render();
}

/* ---------- 初始化 ---------- */

async function init() {
	try {
		state.config = await api("/api/config");
	} catch { state.config = { hasGitHub: false, owner: "" }; }

	try {
		const r = await api("/api/catalog");
		state.catalog = r.catalog;
	} catch (e) {
		state.catalogError = e.message || String(e);
	}
	state.loaded = true;
	window.addEventListener("hashchange", render);
	$("#app").addEventListener("click", onClick);
	render();
	hydrate();
}

/* ---------- 路由 ---------- */

function parseHash() {
	let h = location.hash;
	if (!h || h === "#") h = "#/";
	h = h.replace(/^#/, "");
	if (!h.startsWith("/")) h = "/" + h;
	const qi = h.indexOf("?");
	let path, params;
	if (qi >= 0) {
		path = h.slice(0, qi);
		params = new URLSearchParams(h.slice(qi + 1));
	} else {
		path = h;
		params = new URLSearchParams();
	}
	return { path, params };
}

function render() {
	const route = parseHash();
	const app = $("#app");
	if (route.path === "/new") return renderForm(app, route.params);
	if (route.path === "/search") return renderSearch(app, route.params);
	if (route.path.startsWith("/view/")) return renderViewer(app, route.path, route.params);
	return renderHome(app);
}

/* ---------- 首页 ---------- */

function volumeStatusDot(status) {
	const s = status || "active";
	const label = s === "active" ? "当前" : s === "archived" ? "已封存" : "异常";
	return `<span class="dot ${s}"></span> ${label}`;
}

function recentEntries() {
	return state.index
		.slice()
		.sort((a, b) => (b.id || "").localeCompare(a.id || ""))
		.slice(0, 30);
}

function thumbnails(entry) {
	const imgs = (entry.images || []).slice(0, 3);
	if (imgs.length === 0) return "";
	return `<div class="mthumb">${imgs
		.map(
			(p, i) =>
				`<img loading="lazy" data-action="view-img" data-id="${esc(entry.id)}" data-img="${i + 1}" ` +
				`src="${apiImage(entry.volume, p)}" alt="第${i + 1}张" title="第${i + 1}张" />`
		)
		.join("")}</div>`;
}

function renderHome(app) {
	let top = `
		<div class="topbar">
			<h1>📚 我的手稿</h1>
			<button data-action="nav" data-href="#/new" class="primary">+ 新增手稿</button>
			<button data-action="nav" data-href="#/search">🔍 搜索</button>
		</div>`;

	if (!state.config || !state.config.hasGitHub) {
		top += `<div class="errorbox">后端未连接：请先配置 Cloudflare 环境（GH_TOKEN、OWNER）并部署 Worker。</div>`;
	}
	if (state.catalogError) {
		top += `<div class="errorbox">无法读取总索引：${esc(state.catalogError)}</div>`;
	}

	let draftsHtml = "";
	if (state.drafts.length) {
		draftsHtml = `<div class="card">
			<legend>本地草稿（未提交）</legend>
			<ul class="mlist">${state.drafts
				.map(
					(d) => `<li data-action="edit-draft" data-key="${esc(d.key)}">
						<span class="mdate">${esc(d.date || "")} · ${esc(d.title || "未命名")}</span>
						<span class="v-muted">${esc(d.mode === "update" ? "编辑 " + d.id : "新增")} · ${(d.images || []).length} 张 · ${esc(d.updatedAt || "")}</span>
					</li>`
				)
				.join("")}</ul>
		</div>`;
	}

	let body;
	if (state.hydrating || !state.loaded) {
		body = `<div class="empty"><span class="spinner"></span>正在加载索引…</div>`;
	} else if (!state.catalog || !state.catalog.volumes.length) {
		body = `<div class="empty">还没有手稿。<br />点击「+ 新增手稿」开始第一份。</div>`;
	} else {
		const recent = recentEntries();
		const list = recent.length
			? `<ul class="mlist">${recent
					.map(
						(e) => `<li data-action="view-img" data-id="${esc(e.id)}" data-img="1">
							<span class="mdate">${esc(e.date)} · ${esc(e.id)} · ${esc(e.volume)}</span>
							<span class="mtitle">${esc(e.title)}</span>
							${(e.tags || []).map((t) => `<span class="badge plain">${esc(t)}</span>`).join("")}
							${thumbnails(e)}
						</li>`
					)
					.join("")}</ul>`
			: `<div class="empty">暂无手稿记录。</div>`;

		const vols = `<div class="card"><legend>存储卷</legend><div class="vol-list">${state.catalog.volumes
			.map(
				(v) => `<div class="vol-item">
					<span class="grow">${esc(v.name)}</span>
					<span class="muted">${fmtMb(v.size_mb)}</span>
					<span class="muted">${volumeStatusDot(v.status)}</span>
				</div>`
			)
			.join("")}</div></div>`;

		body = list + vols;
	}

	app.innerHTML = top + draftsHtml + body;
}

/* ---------- 搜索 ---------- */

function renderSearch(app, params) {
	const q = params.get("q") || "";
	let results = [];
	let searched = false;
	if (q.trim()) {
		const kw = q.trim().toLowerCase();
		results = state.index.filter((e) =>
			[e.id, e.title, e.category, e.date, e.note, ...(e.tags || [])]
				.filter(Boolean)
				.some((f) => String(f).toLowerCase().includes(kw))
		);
		searched = true;
	}

	let html = `<div class="topbar"><h1>🔍 搜索</h1><button data-action="nav" data-href="#/">← 返回</button></div>`;

	html += `<div class="searchbar">
		<input id="searchInput" type="text" placeholder="输入关键词：标题 / 标签 / 备注 / 编号" value="${esc(q)}" />
		<button class="primary" data-action="do-search">搜索</button>
	</div>`;

	if (searched) {
		if (results.length === 0) {
			html += `<div class="empty">没有匹配「${esc(q)}」的手稿。</div>`;
		} else {
			html += `<div class="muted" style="margin-bottom:8px">找到 ${results.length} 条</div><ul class="mlist">`;
			html += results
				.sort((a, b) => (b.id || "").localeCompare(a.id || ""))
				.map((e) => {
					const imgs = e.images || [];
					const thumbs = imgs.length
						? `<div class="mthumb">${imgs
								.slice(0, 4)
								.map(
									(p, i) =>
										`<img loading="lazy" data-action="view-img" data-id="${esc(e.id)}" data-img="${i + 1}" ` +
										`src="${apiImage(e.volume, p)}" alt="第${i + 1}张" title="点此查看第${i + 1}张原图" />`
								)
								.join("")}</div>`
						: "";
					return `<li data-action="view-img" data-id="${esc(e.id)}" data-img="1">
						<span class="mdate">${esc(e.date)} · ${esc(e.id)} · ${esc(e.volume)}</span>
						<span class="mtitle">${esc(e.title)}</span>
						<div class="v-muted">标签：${(e.tags || []).map(esc).join(" / ") || "无"} · 📷 ${imgs.length} 张</div>
						${thumbs}
					</li>`;
				})
				.join("");
			html += `</ul>`;
		}
	} else if (!state.loaded) {
		html += `<div class="empty"><span class="spinner"></span>正在加载索引…</div>`;
	} else {
		html += `<div class="empty">输入关键词开始搜索。<br /><span class="muted">搜索基于内存索引，不遍历图片。</span></div>`;
	}

	app.innerHTML = html;
	const input = $("#searchInput");
	if (input) {
		input.focus();
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") submitSearch();
		});
	}
}

function submitSearch() {
	const val = ($("#searchInput") || {}).value || "";
	location.hash = `#/search?q=${encodeURIComponent(val)}`;
}

/* ---------- 手稿表单 ---------- */

const BASE_CATEGORIES = ["学习", "工作", "阅读", "生活", "日记", "未分类", "其他"];

function formCategories() {
	const set = new Set(BASE_CATEGORIES);
	for (const e of state.index) if (e.category) set.add(e.category);
	return [...set];
}

function emptyForm() {
	return {
		mode: "create",
		id: null,
		repository: null,
		date: todayLocal(),
		title: "",
		category: "",
		tags: [],
		note: "",
		images: [], // [{name,dataUrl}]
		existingCount: 0,
	};
}

function loadEditForm(editId, app, params) {
	const f = async () => {
		const found = await findManuscript(editId);
		if (!found) {
			toast("未找到手稿 " + editId, true);
			location.hash = "#/";
			return;
		}
		state.form = {
			mode: "update",
			id: found.entry.id,
			repository: found.volume,
			date: found.entry.date,
			title: found.entry.title || "",
			category: found.entry.category || "",
			tags: (found.entry.tags || []).slice(),
			note: found.entry.note || "",
			images: [],
			existingCount: (found.entry.images || []).length,
		};
		state.currentDraftKey = null;
		paintForm(app, params);
	};
	f();
}

function renderForm(app, params) {
	const draftKey = params.get("draft");
	const editId = params.get("edit");

	if (editId) {
		app.innerHTML = `<div class="empty"><span class="spinner"></span>加载手稿…</div>`;
		loadEditForm(editId, app, params);
		return;
	}

	if (draftKey) {
		const d = state.drafts.find((x) => x.key === draftKey);
		if (d) {
			state.form = {
				mode: d.mode || "create",
				id: d.id || null,
				repository: d.repository || null,
				date: d.date || todayLocal(),
				title: d.title || "",
				category: d.category || "",
				tags: (d.tags || []).slice(),
				note: d.note || "",
				images: (d.images || []).slice(),
				existingCount: d.existingCount || 0,
			};
			state.currentDraftKey = d.key;
		} else {
			state.form = emptyForm();
			state.currentDraftKey = null;
		}
	} else {
		state.form = emptyForm();
		state.currentDraftKey = null;
	}

	paintForm(app, params);
}

function paintForm(app, params) {
	const draftKey = params.get("draft");
	const f = state.form;
	const isEdit = f.mode === "update";
	const isCreate = f.mode === "create";

	let html = `<div class="topbar"><h1>${isEdit ? "修改手稿" : "新增手稿"}</h1><button data-action="nav" data-href="#/">← 返回</button></div>`;

	if (isEdit) {
		html += `<div class="card muted">编号（不可修改）：<strong>${esc(f.id)}</strong> · 所在卷：${esc(f.repository)} · 已有 ${f.existingCount} 张</div>`;
	}
	if (draftKey) {
		html += `<div class="card muted">正在编辑本地草稿，点击「提交」才会同步到 GitHub。</div>`;
	}

	const cats = formCategories();
	html += `
		<div class="card">
			<div class="row" style="margin-bottom:14px">
				<div>
					<label class="muted">日期</label>
					<input type="date" id="f-date" value="${esc(f.date)}" />
				</div>
				<div>
					<label class="muted">分类</label>
					<input type="text" id="f-category" list="cat-list" value="${esc(f.category)}" placeholder="选择或输入" />
					<datalist id="cat-list">${cats.map((c) => `<option value="${esc(c)}"></option>`).join("")}</datalist>
				</div>
			</div>
			<div style="margin-bottom:14px">
				<label class="muted">标题</label>
				<input type="text" id="f-title" value="${esc(f.title)}" placeholder="手稿标题" />
			</div>
			<div style="margin-bottom:14px">
				<label class="muted">标签</label>
				<div class="chips" id="tagChips">
					${f.tags.map((t) => `<span class="chip">${esc(t)}<button data-action="remove-tag" data-tag="${esc(t)}">×</button></span>`).join("")}
				</div>
				<div class="row" style="margin-top:8px">
					<input type="text" id="f-tag" placeholder="新增标签，回车添加" />
					<button data-action="add-tag">添加</button>
				</div>
			</div>
			<div style="margin-bottom:14px">
				<label class="muted">备注</label>
				<textarea id="f-note" placeholder="补充说明…">${esc(f.note)}</textarea>
			</div>
			<div>
				<label class="muted">照片 ${isEdit ? "（新增的照片会追加到现有照片之后）" : ""}</label>
				<input type="file" id="f-files" accept="image/*" multiple style="display:none" />
				<div class="row" style="margin:8px 0 10px">
					<button data-action="add-files" class="primary">+ 添加照片</button>
				</div>
				<div id="imgList">
					${f.images.map((im, i) => `
						<div class="imgrow">
							<img src="${im.dataUrl}" alt="预览${i + 1}" />
							<span class="grow"><small>${esc(im.name || `新增图片 ${i + 1}`)}</small></span>
							<button class="ghost" data-action="img-up" data-i="${i}">↑</button>
							<button class="ghost" data-action="img-down" data-i="${i}">↓</button>
							<button class="ghost danger" data-action="img-remove" data-i="${i}">✕</button>
						</div>`).join("")}
					${f.images.length ? "" : `<div class="muted">尚未添加照片（可提交无照片的手稿）。</div>`}
				</div>
			</div>
			<div class="row" style="margin-top:14px">
				<button id="btn-save">💾 保存（本地草稿）</button>
				<button id="btn-submit" class="primary">上传提交（GitHub）</button>
			</div>
		</div>`;

	app.innerHTML = html;

	$("#f-date").addEventListener("change", (e) => (state.form.date = e.target.value));
	$("#f-title").addEventListener("input", (e) => (state.form.title = e.target.value));
	$("#f-category").addEventListener("input", (e) => (state.form.category = e.target.value));
	$("#f-note").addEventListener("input", (e) => (state.form.note = e.target.value));
	$("#f-tag").addEventListener("keydown", (e) => {
		if (e.key === "Enter") { e.preventDefault(); addTag(); }
	});
	$("#f-files").addEventListener("change", async (e) => {
		const files = [...e.target.files];
		e.target.value = "";
		if (files.length) await addFiles(files);
	});
	$("#btn-save").addEventListener("click", saveCurrentDraft);
	$("#btn-submit").addEventListener("click", submitCurrent);
	$("#btn-submit").disabled = !(state.config && state.config.hasGitHub) ? true : false;
	if (!$("#btn-submit").disabled) {
		$("#btn-submit").title = "确认后提交到 GitHub";
	}
	if (!(state.config && state.config.hasGitHub)) {
		$("#btn-submit").textContent = "后端未连接";
	}
}

function addTag() {
	const v = ($("#f-tag") || {}).value;
	const t = (v || "").trim();
	if (!t) return;
	if (!state.form.tags.includes(t)) state.form.tags.push(t);
	$("#f-tag").value = "";
	const chips = $("#tagChips");
	if (chips) {
		chips.insertAdjacentHTML(
			"beforeend",
			`<span class="chip">${esc(t)}<button data-action="remove-tag" data-tag="${esc(t)}">×</button></span>`
		);
	}
}

async function addFiles(files) {
	for (const file of files) {
		try {
			const p = await processImage(file);
			state.form.images.push({ name: file.name, dataUrl: p.dataUrl });
		} catch (e) {
			toast(`无法处理 ${file.name}：${e.message}`, true);
		}
	}
	render();
}

/* ---------- 视图：图片查看器 ---------- */

function parseViewerPath(path) {
	const rest = path.slice("/view/".length);
	return rest;
}

function renderViewer(app, path, params) {
	const id = parseViewerPath(path);
	const imgParam = parseInt(params.get("image") || "1", 10);

	const renderFound = (entry, volume) => {
		const imgs = entry.images || [];
		const n = Math.min(Math.max(imgParam || 1, 1), Math.max(imgs.length, 1));
		const imgPath = imgs[n - 1];

		let html = `<div class="topbar"><h1>📖 ${esc(entry.title)}</h1>
			<button data-action="nav" data-href="#/">← 返回</button></div>`;

		html += `<div class="card muted">${esc(entry.id)} · ${esc(volume)} · ${esc(entry.date)} · ${(entry.tags || []).map(esc).join(" / ") || "无标签"}</div>`;

		if (imgPath) {
			html += `<div class="viewer">
				<div class="viewer-stage"><img id="viewImg" src="${apiImage(volume, imgPath)}" alt="${esc(filenameOf(imgPath))}" /></div>
				<div class="viewer-nav">
					<button ${n <= 1 ? "disabled" : ""} data-action="view-page" data-id="${esc(id)}" data-n="${n - 1}">← 上一张</button>
					<span class="muted">第 ${n} / ${imgs.length} 张</span>
					<button ${n >= imgs.length ? "disabled" : ""} data-action="view-page" data-id="${esc(id)}" data-n="${n + 1}">下一张 →</button>
				</div>
				<div style="margin-top:10px">
					<a href="${apiImage(volume, imgPath)}" target="_blank" rel="noopener">查看原图</a>
					&nbsp;·&nbsp;
					<a href="${apiImage(volume, imgPath)}" download="${esc(filenameOf(imgPath))}">下载本张</a>
				</div>
			</div>`;
		} else {
			html += `<div class="empty">该手稿没有图片。</div>`;
		}

		if (entry.note) {
			html += `<div class="card"><legend>备注</legend><div style="white-space:pre-wrap">${esc(entry.note)}</div></div>`;
		}

		app.innerHTML = html;
		const img = $("#viewImg");
		if (img) img.addEventListener("error", () => (img.alt = "图片加载失败：可能未同步或路径变化"));
	};

	const load = async () => {
		const found = await findManuscript(id);
		if (!found) {
			app.innerHTML = `<div class="topbar"><h1>未找到</h1><button data-action="nav" data-href="#/">← 返回</button></div>
				<div class="errorbox">手稿 ${esc(id)} 不存在，或在索引中尚未加载。</div>`;
			return;
		}
		renderFound(found.entry, found.volume);
	};

	if (!state.loaded) {
		app.innerHTML = `<div class="empty"><span class="spinner"></span>加载中…</div>`;
		load();
	} else {
		load();
	}
}

/* ---------- 保存 / 提交 ---------- */

function saveCurrentDraft() {
	const f = state.form;
	const key =
		f.mode === "update"
			? `edit-${f.id}`
			: `create-${f.date}-${Date.now()}`;
	const draft = {
		key,
		mode: f.mode,
		id: f.id,
		repository: f.repository,
		date: f.date,
		title: f.title,
		category: f.category,
		tags: f.tags.slice(),
		note: f.note,
		images: f.images.slice(),
		existingCount: f.existingCount,
		updatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
	};
	upsertDraft(draft);
	state.currentDraftKey = key;
	location.hash = `#/new?draft=${encodeURIComponent(key)}`;
	toast("已保存到本地草稿（未提交 GitHub）。");
}

async function submitCurrent() {
	const f = state.form;
	const btn = $("#btn-submit");
	if (btn) { btn.disabled = true; btn.textContent = "提交中…"; }

	const payload = {
		mode: f.mode,
		draft: {
			id: f.id,
			repository: f.repository,
			date: f.date,
			title: f.title,
			category: f.category,
			tags: f.tags,
			note: f.note,
		},
		images: f.images.map((im) => ({ name: im.name, dataUrl: im.dataUrl })),
	};

	try {
		const r = await api("/api/submit", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});

		removeDraftKeyForCurrent();

		await refreshManifest(r.repository);

		if (state.catalog && !state.catalog.volumes.some((v) => v.name === r.repository)) {
			state.catalog.volumes.push({ name: r.repository, size_mb: r.sizeMb || 0, status: "active" });
			state.catalog.active_volume = r.repository;
		}

		state.form = emptyForm();
		state.currentDraftKey = null;

		location.hash = `#/view/${r.id}?image=01`;
		toast(`✓ 已同步：${r.id} → ${r.repository}`);
	} catch (e) {
		render();
		const draftKey = draftKeyForCurrent();
		if (draftKey) {
			const app = $("#app");
			if (app) {
				app.innerHTML =
					`<div class="topbar"><h1>提交失败</h1><button data-action="nav" data-href="#/">← 返回</button></div>
					<div class="errorbox">提交失败。
原因：${esc(e.message || "未知错误")}
${e.code ? "代码：" + esc(e.code) + "\n" : ""}
本地草稿并未丢失，可重新提交。

请在「新增手稿」中恢复草稿：<a data-action="nav" data-href="#/new?draft=${encodeURIComponent(draftKey)}">继续编辑</a></div>
					<button data-action="nav" data-href="#/new?draft=${encodeURIComponent(draftKey)}" class="primary">重新提交</button>`;
			}
		} else {
			toast("提交失败：" + (e.message || "未知错误"), true);
		}
	}
}

function draftKeyForCurrent() {
	return state.currentDraftKey || null;
}

function removeDraftKeyForCurrent() {
	const k = state.currentDraftKey;
	if (k) removeDraft(k);
}

/* ---------- 全局点击委托 ---------- */

function onClick(e) {
	const el = e.target.closest("[data-action]");
	if (!el) return;
	const action = el.dataset.action;

	switch (action) {
		case "nav":
			e.preventDefault();
			location.hash = el.dataset.href;
			break;

		case "view-img":
			location.hash = `#/view/${el.dataset.id}?image=${el.dataset.img}`;
			break;

		case "view-page":
			location.hash = `#/view/${el.dataset.id}?image=${el.dataset.n}`;
			break;

		case "do-search":
			submitSearch();
			break;

		case "edit-draft":
			location.hash = `#/new?draft=${encodeURIComponent(el.dataset.key)}`;
			break;

		case "discard-draft":
			removeDraft(el.dataset.key);
			render();
			break;

		case "add-tag":
			addTag();
			break;

		case "remove-tag": {
			const t = el.dataset.tag;
			if (!state.form) return;
			state.form.tags = state.form.tags.filter((x) => x !== t);
			render();
			break;
		}

		case "add-files":
			($("#f-files") || {}).click && $("#f-files").click();
			break;

		case "img-up": {
			const i = parseInt(el.dataset.i, 10);
			swapImg(i, i - 1);
			render();
			break;
		}
		case "img-down": {
			const i = parseInt(el.dataset.i, 10);
			swapImg(i, i + 1);
			render();
			break;
		}
		case "img-remove": {
			const i = parseInt(el.dataset.i, 10);
			state.form.images.splice(i, 1);
			render();
			break;
		}

		case "save-draft":
			saveCurrentDraft();
			break;

		case "submit-manuscript":
			submitCurrent();
			break;
	}
}

function swapImg(a, b) {
	const arr = state.form.images;
	if (a < 0 || b < 0 || a >= arr.length || b >= arr.length) return;
	const t = arr[a];
	arr[a] = arr[b];
	arr[b] = t;
}

init();
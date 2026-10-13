// Gandalf — pointer and fallback motion.
// CSS (styles/motion.css) owns the choreography; this script only feeds it
// pointer coordinates and covers browsers without scroll-driven animations.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
const scrollTimelines = CSS.supports("animation-timeline: view()");

function initRevealFallback() {
	if (scrollTimelines || reduceMotion) return;
	const targets = document.querySelectorAll<HTMLElement>("[data-reveal], [data-clip-up], [data-line-grow], .converge");
	const io = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				entry.target.classList.add("is-in");
				io.unobserve(entry.target);
			}
		},
		{ rootMargin: "0px 0px -12% 0px", threshold: 0.12 },
	);
	targets.forEach((el) => io.observe(el));
}

function initSpotlight() {
	if (!finePointer) return;
	document.querySelectorAll<HTMLElement>("[data-spotlight]").forEach((el) => {
		el.addEventListener("pointermove", (event) => {
			const rect = el.getBoundingClientRect();
			el.style.setProperty("--mx", `${event.clientX - rect.left}px`);
			el.style.setProperty("--my", `${event.clientY - rect.top}px`);
		});
	});
}

function initMagnetic() {
	if (!finePointer || reduceMotion) return;
	document.querySelectorAll<HTMLElement>("[data-magnetic]").forEach((el) => {
		const strength = Number(el.dataset.magnetic) || 0.3;
		el.addEventListener("pointermove", (event) => {
			const rect = el.getBoundingClientRect();
			const dx = event.clientX - (rect.left + rect.width / 2);
			const dy = event.clientY - (rect.top + rect.height / 2);
			el.classList.add("is-pulling");
			el.style.setProperty("--tx", `${dx * strength}px`);
			el.style.setProperty("--ty", `${dy * strength}px`);
		});
		el.addEventListener("pointerleave", () => {
			el.classList.remove("is-pulling");
			el.style.setProperty("--tx", "0px");
			el.style.setProperty("--ty", "0px");
		});
	});
}

// Decodes section labels ("The Problem", "The Workflow", …) from glyph noise
// the first time they scroll into view.
const GLYPHS = "!<>-_\\/[]{}=+*^?#01";

function scramble(node: Text) {
	const finalText = node.data;
	const start = performance.now();
	const duration = 700;
	const tick = (now: number) => {
		const progress = Math.min(Math.max((now - start) / duration, 0), 1);
		const settled = Math.floor(progress * finalText.length);
		let out = finalText.slice(0, settled);
		for (let i = settled; i < finalText.length; i++) {
			const ch = finalText[i];
			out += ch.trim() === "" ? ch : GLYPHS[(Math.random() * GLYPHS.length) | 0];
		}
		node.data = out;
		if (progress < 1) requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
}

function initScramble() {
	if (reduceMotion) return;
	const io = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (!entry.isIntersecting) continue;
				io.unobserve(entry.target);
				const last = entry.target.lastChild;
				if (last && last.nodeType === Node.TEXT_NODE) scramble(last as Text);
			}
		},
		{ threshold: 1 },
	);
	document.querySelectorAll(".section-meta").forEach((el) => io.observe(el));
}

function initCopyButtons() {
	document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => {
		const label = button.getAttribute("aria-label") ?? "";
		button.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText(button.dataset.copy ?? "");
			} catch {
				return;
			}
			button.classList.add("is-copied");
			button.setAttribute("aria-label", "Copied");
			window.setTimeout(() => {
				button.classList.remove("is-copied");
				button.setAttribute("aria-label", label);
			}, 1600);
		});
	});
}

initRevealFallback();
initSpotlight();
initMagnetic();
initScramble();
initCopyButtons();

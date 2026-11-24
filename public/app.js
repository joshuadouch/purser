// Small progressive enhancements. Every page works without this file.
document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.closest("[data-open-menu]")) document.body.classList.add("menu-open");
  if (t.closest("[data-close-menu]")) document.body.classList.remove("menu-open");
  if (t.closest("[data-print]")) window.print();
  const copy = t.closest("[data-copy]");
  if (copy && navigator.clipboard) {
    navigator.clipboard.writeText(copy.textContent.replace(/\s+/g, "").trim());
    copy.dataset.copied = "1";
    copy.title = "Copied";
  }
  // Whole table rows link to their page.
  const row = t.closest("tr[data-href]");
  if (row && !t.closest("a, button, input, form")) window.location = row.dataset.href;
});

document.addEventListener("submit", (e) => {
  const form = e.target;
  const btn = e.submitter;
  const msg = (btn && btn.dataset.confirm) || form.dataset.confirm;
  if (msg && !window.confirm(msg)) {
    e.preventDefault();
    return;
  }
  // Stop double submits (two payments, two tickets).
  if (form.method.toLowerCase() === "post" && form.target !== "_blank") {
    if (form.dataset.sent) return e.preventDefault();
    form.dataset.sent = "1";
  }
});

// Website header menu on small screens.
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-site-menu]");
  if (!b) return;
  const open = document.querySelector(".site-head").classList.toggle("open");
  b.setAttribute("aria-expanded", open);
});

// Order page: the summary follows the chosen billing period.
document.addEventListener("change", (e) => {
  if (!e.target.closest("[data-cycle-pick]")) return;
  const v = e.target.value;
  document.querySelectorAll("[data-cycle-line]").forEach((el) => (el.hidden = el.dataset.cycleLine !== v));
});

// Order page: check a discount code before ordering.
(() => {
  const btn = document.querySelector("[data-promo-apply]");
  if (!btn) return;
  const form = btn.closest("form");
  const input = form.querySelector('[name="code"]');
  const note = form.querySelector("[data-promo-note]");
  const check = async () => {
    const code = input.value.trim();
    note.className = "small";
    if (!code) return (note.textContent = "");
    const cycle = form.querySelector('[name="cycle"]:checked')?.value || "";
    try {
      const r = await fetch(`${btn.dataset.promoApply}?code=${encodeURIComponent(code)}&cycle=${encodeURIComponent(cycle)}`, { credentials: "same-origin" });
      const d = await r.json();
      note.textContent = d.message;
      note.className = `small ${d.ok ? "ok-text" : "err"}`;
    } catch {
      note.textContent = "";
    }
  };
  btn.addEventListener("click", check);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      check();
    }
  });
  form.addEventListener("change", (e) => {
    if (e.target.name === "cycle" && input.value.trim()) check();
  });
  if (input.value.trim()) check();
})();

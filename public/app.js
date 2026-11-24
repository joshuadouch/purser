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

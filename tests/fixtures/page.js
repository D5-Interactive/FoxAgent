document.querySelectorAll(".remove").forEach((btn, index) => {
  btn.addEventListener("click", () => {
    document.body.dataset.remove = String(index);
  });
});
document.getElementById("go").addEventListener("click", () => {
  document.getElementById("out").textContent = "started";
  const next = document.createElement("button");
  next.textContent = "Continue";
  next.id = "continue";
  document.getElementById("out").append(next);
});
const host = document.getElementById("shadow-host");
const root = host.attachShadow({ mode: "open" });
root.innerHTML = `
  <label for="shadow-field">Shadow label</label>
  <input id="shadow-field" placeholder="Shadow field">
  <button id="shadow-button">Shadow action</button>`;
root.getElementById("shadow-button").addEventListener("click", () => {
  host.dataset.hit = "yes";
});
setTimeout(() => {
  const p = document.createElement("p");
  p.id = "late";
  p.textContent = "Loaded content";
  document.body.append(p);
}, 700);

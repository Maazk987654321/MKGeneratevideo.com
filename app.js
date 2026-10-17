const $ = (s) => document.querySelector(s);
let authMode = "signup", genMode = "t2v", imageData = null, pollTimer = null;

async function api(url, options = {}) {
  const res = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

function setMsg(el, text, ok = false) {
  el.textContent = text;
  el.classList.toggle("ok", ok);
}

function showApp(on) {
  $("#auth").hidden = on;
  $("#app").hidden = !on;
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";
  $("#authTitle").textContent = signup ? "Create your account" : "Welcome back";
  $("#authSubmit").textContent = signup ? "Create account" : "Log in";
  $("#switchAuth").textContent = signup ? "Already have an account? Log in" : "New here? Create an account";
  $("#password").autocomplete = signup ? "new-password" : "current-password";
  setMsg($("#authMsg"), "");
}

$("#switchAuth").onclick = () => setAuthMode(authMode === "signup" ? "login" : "signup");

$("#authForm").onsubmit = async (e) => {
  e.preventDefault();
  const btn = $("#authSubmit");
  btn.disabled = true;
  try {
    const data = await api(authMode === "signup" ? "/api/signup" : "/api/login", {
      method: "POST",
      body: JSON.stringify({ email: $("#email").value, password: $("#password").value }),
    });
    $("#password").value = "";
    showApp(true);
    await loadJobs();
    if (authMode === "signup") {
      setMsg($("#genMsg"), data.freeCreditsGiven
        ? "Welcome! Your 50 free credits are ready."
        : "Account created. Free credits were already used from this network.", data.freeCreditsGiven);
    }
  } catch (err) {
    setMsg($("#authMsg"), err.message);
  } finally {
    btn.disabled = false;
  }
};

$("#logout").onclick = async () => {
  await api("/api/logout", { method: "POST" }).catch(() => {});
  clearTimeout(pollTimer);
  showApp(false);
  setAuthMode("login");
};

document.querySelectorAll(".tab").forEach((tab) => {
  tab.onclick = () => {
    genMode = tab.dataset.mode;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === tab));
    $("#imageField").hidden = genMode !== "i2v";
  };
});

$("#image").onchange = (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) {
    setMsg($("#genMsg"), "Image is too large. Use one under 8 MB.");
    e.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    imageData = reader.result;
    $("#preview").src = imageData;
    $("#preview").hidden = false;
    setMsg($("#genMsg"), "");
  };
  reader.readAsDataURL(file);
};

$("#generate").onclick = async () => {
  const btn = $("#generate");
  btn.disabled = true;
  setMsg($("#genMsg"), "");
  try {
    await api("/api/generate", {
      method: "POST",
      body: JSON.stringify({ mode: genMode, prompt: $("#prompt").value, image: genMode === "i2v" ? imageData : undefined }),
    });
    setMsg($("#genMsg"), "Started. Your video appears below in a minute or two.", true);
    await loadJobs();
  } catch (err) {
    setMsg($("#genMsg"), err.message);
  } finally {
    btn.disabled = false;
  }
};

function clipCard(job) {
  const card = document.createElement("article");
  card.className = "clip";
  if (job.status === "done") {
    const video = document.createElement("video");
    video.src = job.video_url;
    video.controls = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "metadata";
    card.append(video);
  } else {
    const ph = document.createElement("div");
    ph.className = "ph" + (job.status === "failed" ? " fail" : "");
    if (job.status === "pending") ph.innerHTML = '<span class="spin"></span>Generating';
    else ph.textContent = "Failed. Credits returned.";
    card.append(ph);
  }
  const p = document.createElement("p");
  p.textContent = job.prompt;
  card.append(p);
  if (job.status === "done") {
    const a = document.createElement("a");
    a.href = job.video_url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "Download";
    card.append(a);
  }
  return card;
}

async function loadJobs() {
  clearTimeout(pollTimer);
  const data = await api("/api/jobs");
  $("#credits").textContent = data.user.unlimited ? "Unlimited credits" : `${data.user.credits} credits`;
  $("#cost").textContent = data.user.unlimited ? "Owner account: no credits used." : `Each video costs ${data.cost} credits.`;
  $("#gallery").replaceChildren(...data.jobs.map(clipCard));
  $("#empty").hidden = data.jobs.length > 0;
  if (data.jobs.some((j) => j.status === "pending")) pollTimer = setTimeout(() => loadJobs().catch(() => {}), 5000);
}

(async () => {
  setAuthMode("signup");
  try {
    await api("/api/me");
    showApp(true);
    await loadJobs();
  } catch {
    showApp(false);
  }
})();

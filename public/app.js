(function () {
  "use strict";

  var POLL_MS = 3000;
  var TICK_MS = 10000;
  var TIERS = ["critical", "high", "normal", "low"];
  var CHANNEL_LABEL = { call: "Phone call", sms: "SMS", voice: "Voice note", log: "Logged only" };
  var SOURCE_LABEL = { gmail: "Gmail", calendar: "Calendar", telegram: "Telegram", discord: "Discord" };
  var RESPONSE_LABEL = { approved: "Approved", rejected: "Rejected", ignored: "Ignored" };
  var WITHHELD_TEXT = "Financial or one-time-code material is never stored or read aloud.";
  var DASH = "–";

  var dot = document.getElementById("status-dot");
  var feed = document.getElementById("feed");
  var pendingList = document.getElementById("pending");
  var tierBar = document.getElementById("tier-bar");
  var lockTemplate = document.getElementById("lock-icon");

  var firstRender = true;
  var seenDecisions = {};
  var seenPending = {};
  var lastFeedSig = null;
  var lastPendingSig = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function label(map, key, fallback) {
    return map[key] || fallback || String(key || "");
  }

  function relativeTime(iso) {
    var diff = Date.now() - Date.parse(iso);
    if (!isFinite(diff)) return "";
    var s = Math.round(diff / 1000);
    if (s < 45) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.round(m / 60);
    if (h < 24) return h + "h ago";
    return Math.round(h / 24) + "d ago";
  }

  function timeRemaining(iso) {
    var ms = Date.parse(iso) - Date.now();
    if (!isFinite(ms) || ms <= 0) return "Expired";
    var m = Math.ceil(ms / 60000);
    return m < 1 ? "Under a minute left" : m + " min left";
  }

  function timeNode(iso, className) {
    var node = el("time", className, relativeTime(iso));
    node.setAttribute("datetime", iso || "");
    node.setAttribute("data-ts", iso || "");
    return node;
  }

  // Live clocks: relative stamps and countdowns refresh without a refetch.
  function tick() {
    var stamps = document.querySelectorAll("[data-ts]");
    for (var i = 0; i < stamps.length; i++) {
      stamps[i].textContent = relativeTime(stamps[i].getAttribute("data-ts"));
    }
    var timers = document.querySelectorAll("[data-expires]");
    for (var j = 0; j < timers.length; j++) {
      timers[j].textContent = timeRemaining(timers[j].getAttribute("data-expires"));
    }
  }

  function setStatus(state) {
    dot.setAttribute("data-state", state);
  }

  function renderStats(stats, adapters) {
    var values = document.querySelectorAll("[data-stat]");
    for (var i = 0; i < values.length; i++) {
      var key = values[i].getAttribute("data-stat");
      values[i].textContent = typeof stats[key] === "number" ? String(stats[key]) : DASH;
    }

    var active = 0;
    for (var j = 0; j < adapters.length; j++) if (adapters[j].active) active++;
    document.querySelector("[data-adapters]").textContent = String(active);
    document.querySelector("[data-adapters-label]").textContent = active === 1 ? "adapter active" : "adapters active";
  }

  function renderTiers(stats) {
    var total = 0;
    var parts = [];
    for (var i = 0; i < TIERS.length; i++) {
      var n = Number(stats[TIERS[i]]) || 0;
      total += n;
      parts.push(TIERS[i] + " " + n);
      document.querySelector("[data-legend=" + TIERS[i] + "]").textContent = String(n);
    }
    for (var k = 0; k < TIERS.length; k++) {
      var seg = tierBar.querySelector("[data-tier=" + TIERS[k] + "]");
      var count = Number(stats[TIERS[k]]) || 0;
      seg.hidden = count === 0;
      seg.style.width = total ? (100 * count / total).toFixed(2) + "%" : "0%";
    }
    tierBar.setAttribute("aria-label", total ? "Urgency tiers: " + parts.join(", ") : "No events yet");
  }

  function pendingCard(item) {
    var card = el("article", "card approval");
    var head = el("div", "card-head");
    head.appendChild(el("span", "code", item.code || DASH));
    var remaining = el("span", "time remaining", timeRemaining(item.expiresAt));
    remaining.setAttribute("data-expires", item.expiresAt || "");
    head.appendChild(remaining);
    card.appendChild(head);

    var summary = (item.action && item.action.summary) || "Proposed action";
    card.appendChild(el("p", "summary", summary));

    var foot = el("div", "card-foot");
    foot.appendChild(el("span", "meta-key", "Asked via"));
    foot.appendChild(el("span", null, label(CHANNEL_LABEL, item.channel)));
    card.appendChild(foot);
    return card;
  }

  function withheldCard(entry) {
    var card = el("article", "card withheld");
    var head = el("div", "card-head");
    head.appendChild(el("span", "source", label(SOURCE_LABEL, entry.source)));
    head.appendChild(el("span", "chip withheld", "Withheld"));
    head.appendChild(timeNode(entry.recordedAt, "time"));
    card.appendChild(head);

    var body = el("div", "withheld-body");
    var lock = el("span", "lock");
    lock.appendChild(lockTemplate.content.cloneNode(true));
    body.appendChild(lock);
    var text = el("p", "withheld-text");
    text.appendChild(el("strong", null, "Content withheld."));
    text.appendChild(el("span", null, WITHHELD_TEXT));
    body.appendChild(text);
    card.appendChild(body);

    var foot = el("div", "card-foot");
    foot.appendChild(el("span", "meta-key", "Channel"));
    foot.appendChild(el("span", null, CHANNEL_LABEL.log));
    card.appendChild(foot);
    return card;
  }

  function decisionCard(entry) {
    if (entry.category === "financial") return withheldCard(entry);

    var card = el("article", "card");
    var head = el("div", "card-head");
    head.appendChild(el("span", "source", label(SOURCE_LABEL, entry.source)));
    head.appendChild(el("span", "chip " + (TIERS.indexOf(entry.tier) >= 0 ? entry.tier : "low"), entry.tier || "unknown"));
    head.appendChild(timeNode(entry.recordedAt, "time"));
    card.appendChild(head);

    card.appendChild(el("p", "card-body", entry.reason || ""));
    if (entry.redactedText) {
      card.appendChild(el("p", "preview", String(entry.redactedText).replace(/\s+/g, " ").trim()));
    }

    var foot = el("div", "card-foot");
    foot.appendChild(el("span", "meta-key", "Channel"));
    foot.appendChild(el("span", null, label(CHANNEL_LABEL, entry.channel)));
    if (entry.response && RESPONSE_LABEL[entry.response]) {
      foot.appendChild(el("span", "response", RESPONSE_LABEL[entry.response]));
    }
    card.appendChild(foot);
    return card;
  }

  // Rebuild a list only when its data changed; animate only ids never shown before.
  function renderList(container, items, keyOf, build, seen, emptyText) {
    var frag = document.createDocumentFragment();
    if (!items.length) {
      frag.appendChild(el("p", "empty", emptyText));
    }
    for (var i = 0; i < items.length; i++) {
      var key = keyOf(items[i]);
      var node = build(items[i]);
      if (!firstRender && !seen[key]) node.classList.add("enter");
      seen[key] = true;
      frag.appendChild(node);
    }
    container.replaceChildren(frag);
  }

  function render(data) {
    var stats = data.stats || {};
    var decisions = Array.isArray(data.decisions) ? data.decisions : [];
    var pending = Array.isArray(data.pending) ? data.pending : [];

    renderStats(stats, Array.isArray(data.adapters) ? data.adapters : []);
    renderTiers(stats);

    var pendingSig = JSON.stringify(pending);
    if (pendingSig !== lastPendingSig) {
      lastPendingSig = pendingSig;
      renderList(pendingList, pending, function (p) { return p.code; }, pendingCard, seenPending, "Nothing awaiting your approval.");
      document.getElementById("pending-count").textContent = pending.length ? String(pending.length) : "";
    }

    var feedSig = JSON.stringify(decisions);
    if (feedSig !== lastFeedSig) {
      lastFeedSig = feedSig;
      renderList(feed, decisions, function (d) { return d.id; }, decisionCard, seenDecisions, "No decisions recorded yet.");
      document.getElementById("feed-count").textContent = typeof stats.total === "number" && stats.total ? String(stats.total) : "";
    }

    firstRender = false;
  }

  function poll() {
    fetch("/api/state", { cache: "no-store" })
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(function (data) {
        render(data);
        setStatus("ok");
      })
      .catch(function () {
        setStatus("stale");
      })
      .then(function () {
        setTimeout(poll, POLL_MS);
      });
  }

  poll();
  setInterval(tick, TICK_MS);
})();

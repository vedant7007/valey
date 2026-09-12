(function () {
  "use strict";

  var POLL_MS = 1500;
  var TICK_MS = 1000;
  var COUNT_MS = 400;
  var LEAVE_MS = 200;
  var TIMELINE_SLOTS = 20;
  var TIERS = ["critical", "high", "normal", "low"];
  var TIER_HEIGHT = { critical: 100, high: 74, normal: 48, low: 22 };
  var CHANNEL_LABEL = { call: "Phone call", sms: "SMS", voice: "Voice note", log: "Logged only" };
  var SOURCE_LABEL = { gmail: "Gmail", calendar: "Calendar", telegram: "Telegram", discord: "Discord" };
  var RESPONSE_LABEL = { approved: "Approved", rejected: "Declined", ignored: "Ignored" };
  var WORKING_LABEL = { approve: "Releasing…", decline: "Declining…" };
  var WITHHELD_TEXT = "Financial or one-time-code material is never stored or read aloud.";
  var DASH = "–";
  var SVG_NS = "http://www.w3.org/2000/svg";

  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var dot = document.getElementById("status-dot");
  var pulse = document.getElementById("pulse");
  var feed = document.getElementById("feed");
  var pendingList = document.getElementById("pending");
  var tierBar = document.getElementById("tier-bar");
  var spark = document.getElementById("spark");
  var lastEvent = document.getElementById("last-event");
  var lockTemplate = document.getElementById("lock-icon");

  var firstRender = true;
  var lastData = null;
  var lastEventAt = null;
  var sourceFilter = "";
  var seenDecisions = {};
  var seenPending = {};
  var handledPending = {};
  var cardState = {};
  var lastFeedSig = null;
  var lastPendingSig = null;
  var lastTimelineSig = null;

  pulse.style.setProperty("--poll", POLL_MS + "ms");

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }

  function label(map, key) {
    return map[key] || String(key || "");
  }

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
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

  // Seconds resolution for the header ticker so the page visibly moves while idle.
  function preciseTime(iso) {
    var s = Math.floor((Date.now() - Date.parse(iso)) / 1000);
    if (!isFinite(s)) return "";
    if (s < 0) s = 0;
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m " + pad(s % 60) + "s ago";
    var h = Math.floor(m / 60);
    if (h < 24) return h + "h " + pad(m % 60) + "m ago";
    return Math.floor(h / 24) + "d ago";
  }

  function timeRemaining(iso) {
    var ms = Date.parse(iso) - Date.now();
    if (!isFinite(ms) || ms <= 0) return "Expired";
    var m = Math.ceil(ms / 60000);
    return m < 1 ? "Under a minute left" : m + " min left";
  }

  function duration(seconds) {
    if (seconds < 60) return seconds + "s";
    if (seconds < 3600) return Math.round(seconds / 60) + "m";
    return Math.round(seconds / 3600) + "h";
  }

  function timeNode(iso, className) {
    var node = el("time", className, relativeTime(iso));
    node.setAttribute("datetime", iso || "");
    node.setAttribute("data-ts", iso || "");
    return node;
  }

  function pendingKey(item) {
    return (item.code || "") + "@" + (item.createdAt || "");
  }

  // Live clocks: stamps, countdowns and the header ticker refresh without a refetch.
  function tick() {
    var stamps = document.querySelectorAll("[data-ts]");
    for (var i = 0; i < stamps.length; i++) {
      stamps[i].textContent = relativeTime(stamps[i].getAttribute("data-ts"));
    }
    var timers = document.querySelectorAll("[data-expires]");
    for (var j = 0; j < timers.length; j++) {
      timers[j].textContent = timeRemaining(timers[j].getAttribute("data-expires"));
    }
    if (lastEventAt) lastEvent.textContent = preciseTime(lastEventAt);
  }

  function setStatus(state) {
    dot.setAttribute("data-state", state);
  }

  function restartPulse() {
    pulse.classList.remove("run");
    void pulse.offsetWidth;
    pulse.classList.add("run");
  }

  // Counts from the value on screen to the new one; a newer call cancels an older run.
  function setNumber(node, value) {
    var from = parseInt(node.textContent, 10);
    node._count = null;
    if (firstRender || !isFinite(from) || from === value || reducedMotion.matches) {
      node.textContent = String(value);
      return;
    }
    var token = {};
    var start = performance.now();
    node._count = token;
    function step(now) {
      if (node._count !== token) return;
      var t = Math.min(1, (now - start) / COUNT_MS);
      var eased = 1 - Math.pow(1 - t, 3);
      node.textContent = String(Math.round(from + (value - from) * eased));
      if (t < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function renderStats(stats, adapters) {
    var values = document.querySelectorAll("[data-stat]");
    for (var i = 0; i < values.length; i++) {
      var key = values[i].getAttribute("data-stat");
      if (typeof stats[key] === "number") setNumber(values[i], stats[key]);
      else values[i].textContent = DASH;
    }

    var active = 0;
    for (var j = 0; j < adapters.length; j++) if (adapters[j].active) active++;
    document.querySelector("[data-adapters]").textContent = String(active);
    document.querySelector("[data-adapters-label]").textContent = active === 1 ? "adapter active" : "adapters active";

    var avg = document.getElementById("avg-response");
    avg.textContent = typeof stats.avgResponseSeconds === "number" ? "Avg response " + duration(stats.avgResponseSeconds) : "";
  }

  function renderTiers(stats) {
    var total = 0;
    var parts = [];
    for (var i = 0; i < TIERS.length; i++) {
      var n = Number(stats[TIERS[i]]) || 0;
      total += n;
      parts.push(TIERS[i] + " " + n);
      setNumber(document.querySelector("[data-legend=" + TIERS[i] + "]"), n);
    }
    for (var k = 0; k < TIERS.length; k++) {
      var seg = tierBar.querySelector("[data-tier=" + TIERS[k] + "]");
      var count = Number(stats[TIERS[k]]) || 0;
      seg.hidden = count === 0;
      seg.style.width = total ? (100 * count / total).toFixed(2) + "%" : "0%";
    }
    tierBar.setAttribute("aria-label", total ? "Urgency tiers: " + parts.join(", ") : "No events yet");
  }

  // Twenty slots, oldest left; unfilled slots draw as stubs so the shape is stable.
  function renderSpark(timeline) {
    var sig = JSON.stringify(timeline);
    if (sig === lastTimelineSig) return;
    lastTimelineSig = sig;

    var slotWidth = 100 / TIMELINE_SLOTS;
    var barWidth = slotWidth * 0.62;
    var offset = TIMELINE_SLOTS - timeline.length;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < TIMELINE_SLOTS; i++) {
      var entry = i >= offset ? timeline[i - offset] : null;
      var height = entry ? (TIER_HEIGHT[entry.tier] || TIER_HEIGHT.low) : 6;
      frag.appendChild(svgEl("rect", {
        x: (i * slotWidth + (slotWidth - barWidth) / 2).toFixed(2),
        y: (100 - height).toFixed(2),
        width: barWidth.toFixed(2),
        height: height,
        "class": entry ? (TIERS.indexOf(entry.tier) >= 0 ? entry.tier : "low") : "stub"
      }));
    }
    spark.replaceChildren(frag);
    spark.setAttribute("aria-label", timeline.length ? "Urgency of the last " + timeline.length + " events" : "No events yet");
  }

  function pendingCard(item) {
    var key = pendingKey(item);
    var card = el("article", "card approval");
    card.setAttribute("data-key", key);
    card.setAttribute("data-code", item.code || "");

    var head = el("div", "card-head");
    head.appendChild(el("span", "code", item.code || DASH));
    var remaining = el("span", "time remaining", timeRemaining(item.expiresAt));
    remaining.setAttribute("data-expires", item.expiresAt || "");
    head.appendChild(remaining);
    card.appendChild(head);

    card.appendChild(el("p", "summary", (item.action && item.action.summary) || "Proposed action"));

    var foot = el("div", "card-foot");
    foot.appendChild(el("span", "meta-key", "Asked via"));
    foot.appendChild(el("span", null, label(CHANNEL_LABEL, item.channel)));
    card.appendChild(foot);

    var actions = el("div", "actions");
    var release = el("button", "btn primary", "Release");
    release.type = "button";
    release.setAttribute("data-act", "approve");
    var decline = el("button", "btn", "Decline");
    decline.type = "button";
    decline.setAttribute("data-act", "decline");
    actions.appendChild(release);
    actions.appendChild(decline);
    card.appendChild(actions);

    var note = el("p", "note");
    note.hidden = true;
    card.appendChild(note);

    applyCardState(card, cardState[key]);
    return card;
  }

  // Working and failure states live in cardState so a poll re-render cannot wipe them mid-request.
  function applyCardState(card, state) {
    var buttons = card.querySelectorAll("[data-act]");
    var note = card.querySelector(".note");
    var busy = state && state.working;
    for (var i = 0; i < buttons.length; i++) {
      var act = buttons[i].getAttribute("data-act");
      buttons[i].disabled = Boolean(busy);
      buttons[i].textContent = busy === act ? WORKING_LABEL[act] : (act === "approve" ? "Release" : "Decline");
    }
    if (busy) card.setAttribute("aria-busy", "true");
    else card.removeAttribute("aria-busy");
    note.hidden = !(state && state.error);
    note.textContent = (state && state.error) || "";
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

    var tier = TIERS.indexOf(entry.tier) >= 0 ? entry.tier : "low";
    var card = el("article", "card tier-" + tier);
    var head = el("div", "card-head");
    head.appendChild(el("span", "source", label(SOURCE_LABEL, entry.source)));
    head.appendChild(el("span", "chip " + tier, entry.tier || "unknown"));
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

  function renderList(container, items, keyOf, build, fresh, animClass, emptyText) {
    var frag = document.createDocumentFragment();
    if (!items.length) frag.appendChild(el("p", "empty", emptyText));
    for (var i = 0; i < items.length; i++) {
      var node = build(items[i]);
      if (!firstRender && fresh[keyOf(items[i])]) node.classList.add(animClass);
      frag.appendChild(node);
    }
    container.replaceChildren(frag);
  }

  function renderPending(pending, fresh) {
    var visible = [];
    for (var i = 0; i < pending.length; i++) {
      if (!handledPending[pendingKey(pending[i])]) visible.push(pending[i]);
    }
    var sig = JSON.stringify(visible);
    if (sig === lastPendingSig) return;
    lastPendingSig = sig;
    renderList(pendingList, visible, pendingKey, pendingCard, fresh, "enter", "Nothing awaiting your approval.");
    document.getElementById("pending-count").textContent = visible.length ? String(visible.length) : "";
  }

  function renderFeed(decisions, fresh) {
    var visible = [];
    for (var i = 0; i < decisions.length; i++) {
      if (!sourceFilter || decisions[i].source === sourceFilter) visible.push(decisions[i]);
    }
    var sig = sourceFilter + "|" + JSON.stringify(visible);
    if (sig === lastFeedSig) return;
    lastFeedSig = sig;
    var emptyText = sourceFilter ? "Nothing from " + label(SOURCE_LABEL, sourceFilter) + " yet." : "No decisions recorded yet.";
    renderList(feed, visible, function (d) { return d.id; }, decisionCard, fresh, "flash", emptyText);
    document.getElementById("feed-count").textContent = visible.length ? String(visible.length) : "";
  }

  function render(data) {
    lastData = data;
    var stats = data.stats || {};
    var decisions = Array.isArray(data.decisions) ? data.decisions : [];
    var pending = Array.isArray(data.pending) ? data.pending : [];
    var timeline = Array.isArray(data.timeline) ? data.timeline : [];

    // Mark arrivals against everything fetched, not just what the filter shows.
    var freshDecisions = {};
    for (var i = 0; i < decisions.length; i++) {
      if (!seenDecisions[decisions[i].id]) freshDecisions[decisions[i].id] = seenDecisions[decisions[i].id] = true;
    }
    var freshPending = {};
    for (var j = 0; j < pending.length; j++) {
      var key = pendingKey(pending[j]);
      if (!seenPending[key]) freshPending[key] = seenPending[key] = true;
    }

    if (decisions.length && decisions[0].recordedAt) {
      lastEventAt = decisions[0].recordedAt;
      lastEvent.textContent = preciseTime(lastEventAt);
    }

    renderStats(stats, Array.isArray(data.adapters) ? data.adapters : []);
    renderTiers(stats);
    renderSpark(timeline);
    renderPending(pending, freshPending);
    renderFeed(decisions, freshDecisions);
    firstRender = false;
  }

  function detachCard(card) {
    if (card.parentNode) card.parentNode.removeChild(card);
    if (!pendingList.querySelector(".card")) {
      pendingList.replaceChildren(el("p", "empty", "Nothing awaiting your approval."));
    }
    var left = pendingList.querySelectorAll(".card").length;
    document.getElementById("pending-count").textContent = left ? String(left) : "";
  }

  function removeCard(card) {
    if (reducedMotion.matches) {
      detachCard(card);
      return;
    }
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      detachCard(card);
    }
    card.addEventListener("animationend", finish);
    setTimeout(finish, LEAVE_MS + 100);
    card.classList.add("leave");
  }

  function act(card, action) {
    var key = card.getAttribute("data-key");
    var code = card.getAttribute("data-code");
    cardState[key] = { working: action };
    applyCardState(card, cardState[key]);

    fetch("/api/" + action, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: code })
    })
      .then(function (response) { return response.json(); })
      .catch(function () { return { ok: false, reason: "Could not reach Valey. Try again." }; })
      .then(function (result) {
        var current = pendingList.querySelector('[data-key="' + key + '"]') || card;
        if (result && result.ok) {
          handledPending[key] = true;
          delete cardState[key];
          removeCard(current);
          return;
        }
        cardState[key] = { error: (result && result.reason) || "Request failed." };
        applyCardState(current, cardState[key]);
      });
  }

  pendingList.addEventListener("click", function (event) {
    var button = event.target.closest("[data-act]");
    if (!button || button.disabled) return;
    var card = button.closest(".approval");
    if (card) act(card, button.getAttribute("data-act"));
  });

  document.getElementById("filters").addEventListener("click", function (event) {
    var button = event.target.closest("[data-source]");
    if (!button) return;
    sourceFilter = button.getAttribute("data-source") || "";
    var buttons = button.parentNode.querySelectorAll("[data-source]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i] === button ? "true" : "false");
    }
    if (lastData) renderFeed(Array.isArray(lastData.decisions) ? lastData.decisions : [], {});
  });

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
        restartPulse();
        setTimeout(poll, POLL_MS);
      });
  }

  poll();
  setInterval(tick, TICK_MS);
})();
